// Package keyauth 是 LLM 请求的 key-auth 最小占位实现。
//
// 真正的 API key 签发 / 吊销 / key→user 映射归将来的 Go auth 模块（AGENTS.md §5）。
// 本模块只做这一刀：
//   - 从 Authorization: Bearer 解析调用方密钥；
//   - 配置了静态密钥时做常量时间比对，否则接受任何非空密钥（明确标记为占位）；
//   - 写 Ctx.Key 与 Ctx.Profile，供后续阶段使用；
//   - 拒绝时返回 401，由 engine 统一渲染。
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
// Keys 为空表示占位模式：任何非空 Bearer 密钥都放行。这只适合开发；
// 生产必须由真正的 auth 模块替换（见 AGENTS.md §5）。
type Config struct {
	Keys    []string
	Profile string
}

// Stage 是 pre 相位的最小鉴权阶段。
type Stage struct {
	keys    []string
	profile string
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
	return &Stage{keys: keys, profile: profile}
}

// Placeholder 表示是否处于「接受任何非空密钥」的占位模式。
func (s *Stage) Placeholder() bool { return len(s.keys) == 0 }

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

	if len(s.keys) > 0 && !s.matches(token) {
		return contracts.Decision{}, contracts.Errorf(http.StatusUnauthorized, "INVALID_API_KEY", "API key 无效")
	}

	ctx.Key = &contracts.APIKey{ID: keyID(token), Profile: s.profile}
	ctx.Profile = s.profile
	return contracts.Decision{Action: contracts.ActionContinue}, nil
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
	if s.Placeholder() {
		return fmt.Sprintf("key-auth 占位模式：接受任何非空 Bearer key，profile=%s", s.profile)
	}
	return fmt.Sprintf("key-auth：%d 个静态 key，profile=%s", len(s.keys), s.profile)
}
