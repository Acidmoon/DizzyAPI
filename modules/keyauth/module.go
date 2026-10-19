// Package keyauth 是 LLM 请求的 key-auth 阶段。
//
// 两种模式，按「Go 侧是否有动态 key 快照」切换：
//
//  1. **动态 API key（生产路径）**：TS 的 api-key 插件经控制桥把只读哈希快照
//     推给 Go。`Config.Verifier` 非空且 `Count() > 0` 时，只认快照里的 key；
//     未命中直接 401，**不回退**到环境变量或占位模式。
//  2. **静态 key / 占位（启动与降级路径）**：快照为空时沿用
//     `DIZZYAPI_API_KEYS`；未配置时接受任何非空 Bearer，并在 Describe 里明确
//     标注为占位。快照为空可能是 gatewayd 刚启动、TS 尚未推送，也可能是
//     api-key 插件被禁用——这两种情况都只适合开发与降级。
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
// Keys 是静态环境变量 key（启动/降级路径）；Verifier 是控制桥推来的动态
// 哈希快照（生产路径）。两者同时存在时，快照非空即完全接管。
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
// 动态快照非空时永远不是占位模式。
func (s *Stage) Placeholder() bool { return len(s.keys) == 0 && !s.hasDynamicKeys() }

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

// Run 解析并校验 Authorization 头。
func (s *Stage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	if ctx == nil {
		return contracts.Decision{}, contracts.Errorf(http.StatusInternalServerError, "KEY_AUTH_INVALID_REQUEST", "请求上下文为空")
	}
	token, err := bearerToken(ctx.Headers)
	if err != nil {
		return contracts.Decision{}, err
	}

	// 动态快照优先，且绝不回退：快照非空时环境变量 key 与占位模式都失效。
	if s.hasDynamicKeys() {
		record, ok := s.verifier.Verify(token)
		if !ok {
			return contracts.Decision{}, contracts.Errorf(http.StatusUnauthorized, "INVALID_API_KEY", "API key 无效")
		}
		profile := strings.TrimSpace(record.Profile)
		if profile == "" {
			profile = s.profile
		}
		ctx.Key = &contracts.APIKey{
			ID:      record.KeyID,
			KeyID:   record.KeyID,
			UserID:  record.UserID,
			Name:    record.Name,
			Profile: profile,
		}
		ctx.Profile = profile
		return contracts.Decision{Action: contracts.ActionContinue}, nil
	}

	if len(s.keys) > 0 && !s.matches(token) {
		return contracts.Decision{}, contracts.Errorf(http.StatusUnauthorized, "INVALID_API_KEY", "API key 无效")
	}

	ctx.Key = &contracts.APIKey{ID: keyID(token), Profile: s.profile}
	ctx.Profile = s.profile
	return contracts.Decision{Action: contracts.ActionContinue}, nil
}

func (s *Stage) hasDynamicKeys() bool {
	return s.verifier != nil && s.verifier.Count() > 0
}

func bearerToken(headers http.Header) (string, error) {
	if headers == nil {
		return "", contracts.Errorf(http.StatusUnauthorized, "MISSING_API_KEY", "缺少 Authorization: Bearer API key")
	}
	value := strings.TrimSpace(headers.Get("Authorization"))
	if value == "" {
		return "", contracts.Errorf(http.StatusUnauthorized, "MISSING_API_KEY", "缺少 Authorization: Bearer API key")
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
	if s.hasDynamicKeys() {
		return fmt.Sprintf(
			"key-auth：动态 API key 快照（%d 个，来自控制桥）；静态 key / 占位模式已停用",
			s.verifier.Count(),
		)
	}
	if s.Placeholder() {
		return fmt.Sprintf(
			"key-auth 占位模式（启动/降级路径）：接受任何非空 Bearer key，profile=%s",
			s.profile,
		)
	}
	return fmt.Sprintf(
		"key-auth：%d 个静态 key，profile=%s（启动/降级路径；等待控制桥快照）",
		len(s.keys), s.profile,
	)
}
