// Package keyauth 是 LLM 请求的 key-auth 阶段。
//
// 两种模式，按「Go 侧是否已经收到过至少一份 keys.replace 快照」切换：
//
//  1. **动态 API key（生产路径）**：`Config.Verifier.Ready()` 为 true 时，只认
//     快照里的 key；未命中直接 401，**永不回退**到环境变量或占位模式。
//     合法的空快照（用户删光 key / 全部停用 / 用户封禁）同样是 Ready=true：
//     此时拒绝全部 key，而不是放开（D7：fail-closed）。
//  2. **静态 key / 占位（尚未收到快照的启动/降级路径）**：Ready=false 时沿用
//     `DIZZYAPI_API_KEYS`；未配置时接受任何非空 Bearer，并在 Describe 里明确
//     标注为占位。这只适合 gatewayd 刚启动、TS 还没来得及推送的时间窗。
//
// 它不记录、不回显、不向上游转发密钥。
package keyauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// ServiceName 是注册表里的服务名。
	ServiceName = "key-auth"
	// StageName 是描述符里的阶段名。
	StageName = "key-auth"
	// DefaultProfile 是未配置 profile 时写入 Ctx 的标签。
	DefaultProfile = "billed"
)

// Config 是 key-auth 的启动配置。
//
// Keys 是静态环境变量 key（尚未收到快照的启动/降级路径）；Verifier 是控制桥
// 推来的动态哈希快照（生产路径）。一旦 Verifier.Ready() 为 true，即使快照为空，
// 静态 key 也完全失效。
type Config struct {
	Keys     []string
	Profile  string
	Verifier contracts.APIKeyVerifier
}

// Stage 是 pre 相位的鉴权阶段。
type Stage struct {
	keys     []string
	profile  string
	verifier contracts.APIKeyVerifier
}

// New 构造阶段。空密钥会被忽略。
func New(cfg Config) *Stage {
	profile := strings.TrimSpace(cfg.Profile)
	if profile == "" {
		profile = DefaultProfile
	}
	keys := make([]string, 0, len(cfg.Keys))
	for _, key := range cfg.Keys {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			keys = append(keys, trimmed)
		}
	}
	return &Stage{keys: keys, profile: profile, verifier: cfg.Verifier}
}

// Placeholder 表示是否处于「接受任何非空密钥」的占位模式。
// 只要收到过快照（即使为空），就永远不是占位模式。
func (s *Stage) Placeholder() bool { return len(s.keys) == 0 && !s.hasSnapshot() }

// Register 把 key-auth 阶段挂到组合根上。
func Register(reg *contracts.Registry, cfg Config) *Stage {
	stage := New(cfg)
	reg.Service(ServiceName, stage)
	reg.Stage(stage)
	return stage
}

func (s *Stage) Name() string           { return StageName }
func (s *Stage) Phase() contracts.Phase { return contracts.PhasePre }
func (s *Stage) Required() bool         { return true }
func (s *Stage) NeedBody() bool         { return false }

// Run 解析并校验 Authorization / x-api-key 头。
func (s *Stage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	if ctx == nil {
		return contracts.Decision{}, contracts.Errorf(http.StatusInternalServerError, "KEY_AUTH_INVALID_REQUEST", "请求上下文为空")
	}
	key, err := s.Authorize(ctx.Headers)
	if err != nil {
		return contracts.Decision{}, err
	}
	ctx.Key = key
	ctx.Profile = key.Profile
	return contracts.Decision{Action: contracts.ActionContinue}, nil
}

// Authorize 校验 Authorization / x-api-key 头并返回调用方身份，语义与 Run 完全一致。
//
// 它供不经过 engine 的路由（如 GET /v1/models）复用同一套判定，避免另写一套鉴权：
//   - 已收到过快照：只认快照里的 key，未命中直接 401，绝不回退（空快照同样 fail-closed）；
//   - 尚未收到快照：沿用静态 key；未配置静态 key 时接受任何非空 Bearer（占位模式）。
//
// 返回的 *APIKey 只含指纹 / 用户 id 等非秘密字段；错误是 *contracts.StageError。
func (s *Stage) Authorize(headers http.Header) (*contracts.APIKey, error) {
	token, err := bearerToken(headers)
	if err != nil {
		return nil, err
	}

	// 动态快照优先，且绝不回退：只要收到过快照，环境变量 key 与占位模式都失效。
	// 空快照同样走这里——Verify 必然 false，于是全部请求 401（fail-closed）。
	if s.hasSnapshot() {
		record, ok := s.verifier.Verify(token)
		if !ok {
			return nil, contracts.Errorf(http.StatusUnauthorized, "INVALID_API_KEY", "API key 无效")
		}
		profile := strings.TrimSpace(record.Profile)
		if profile == "" {
			profile = s.profile
		}
		return &contracts.APIKey{
			ID:                  record.KeyID,
			KeyID:               record.KeyID,
			UserID:              record.UserID,
			Name:                record.Name,
			Profile:             profile,
			ExpiresAt:           record.ExpiresAt,
			SpendingLimitMicros: record.SpendingLimitMicros,
			ConcurrencyLimit:    record.ConcurrencyLimit,
		}, nil
	}

	if len(s.keys) > 0 && !s.matches(token) {
		return nil, contracts.Errorf(http.StatusUnauthorized, "INVALID_API_KEY", "API key 无效")
	}

	return &contracts.APIKey{ID: keyID(token), Profile: s.profile}, nil
}

// hasSnapshot 表示动态模式是否已经接管。
// 不能用 Count() > 0 判断：合法的空快照也必须 fail-closed。
func (s *Stage) hasSnapshot() bool {
	return s.verifier != nil && s.verifier.Ready()
}

func bearerToken(headers http.Header) (string, error) {
	if headers == nil {
		return "", contracts.Errorf(http.StatusUnauthorized, "MISSING_API_KEY", "缺少 Authorization: Bearer 或 x-api-key")
	}
	value := strings.TrimSpace(headers.Get("Authorization"))
	if value == "" {
		// Anthropic 客户端标准用 x-api-key，不带 Authorization；/v1/messages
		// 必须接受这种写法，否则 Claude Code / Anthropic SDK 直接 401。
		if key := strings.TrimSpace(headers.Get("x-api-key")); key != "" {
			return key, nil
		}
		return "", contracts.Errorf(http.StatusUnauthorized, "MISSING_API_KEY", "缺少 Authorization: Bearer 或 x-api-key")
	}
	scheme, token, found := strings.Cut(value, " ")
	if !found || !strings.EqualFold(strings.TrimSpace(scheme), "Bearer") {
		return "", contracts.Errorf(http.StatusUnauthorized, "INVALID_API_KEY", "Authorization 必须是 Bearer 方案")
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return "", contracts.Errorf(http.StatusUnauthorized, "MISSING_API_KEY", "Bearer 后面没有 API key")
	}
	return token, nil
}

func (s *Stage) matches(token string) bool {
	matched := 0
	for _, candidate := range s.keys {
		matched |= subtle.ConstantTimeCompare([]byte(token), []byte(candidate))
	}
	return matched == 1
}

// keyID 只返回不可逆的短指纹；它不能用于还原密钥。
func keyID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "key-" + hex.EncodeToString(sum[:6])
}

// Describe 是给人看的启动信息（不含密钥）。
func (s *Stage) Describe() string {
	if s.hasSnapshot() {
		count := s.verifier.Count()
		if count == 0 {
			return "key-auth：已收到空 API key 快照（控制桥）；合法地没有可用 key，拒绝全部请求"
		}
		return fmt.Sprintf(
			"key-auth：动态 API key 快照（%d 个，来自控制桥）；静态 key / 占位模式已停用",
			count,
		)
	}
	if s.Placeholder() {
		return fmt.Sprintf(
			"key-auth 占位模式（尚未收到控制桥快照）：接受任何非空 Bearer key，profile=%s",
			s.profile,
		)
	}
	return fmt.Sprintf(
		"key-auth：%d 个静态 key，profile=%s（尚未收到控制桥快照）",
		len(s.keys), s.profile,
	)
}
