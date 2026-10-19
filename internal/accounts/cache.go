// Package accounts 是 Go 侧的账号/令牌只读快照缓存。
//
// 权威写者是 TS 的 identity 插件（D8 / D17 / D18）：它经控制桥把「可用的账号 +
// 访问令牌」整份推过来，本包只校验、原子替换、在内存里提供读取。
// 它不读 credentials.json，不刷新令牌，也不把令牌写进日志、HTTP 或桥响应。
package accounts

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// SnapshotVersion 是桥消息里的快照版本。
	SnapshotVersion = 1
	// MaxAccounts 一份快照最多容纳的账号数。
	MaxAccounts = 10_000
	// MaxTokenBytes 单个访问令牌的长度上限。
	MaxTokenBytes = 16 << 10
	// MaxBaseURLBytes 单个 base URL 的长度上限。
	MaxBaseURLBytes = 2_048
	// ExpirySafety 是「即将过期」的提前量；低于它的令牌不再参与选择。
	ExpirySafety = 30 * time.Second
)

// Snapshot 是 TS 推来的完整账号快照。任何一条不合法就整份拒绝，绝不部分应用。
type Snapshot struct {
	Version    int       `json:"version"`
	Generation string    `json:"generation,omitempty"`
	Accounts   []Account `json:"accounts"`
}

// Account 是快照里的一个账号。Token 只存在于内存与桥帧里。
type Account struct {
	AccountID string            `json:"accountId"`
	Provider  string            `json:"provider"`
	Kind      string            `json:"kind,omitempty"`
	BaseURL   string            `json:"baseUrl"`
	Token     string            `json:"token"`
	ExpiresAt *time.Time        `json:"expiresAt,omitempty"`
	Priority  int               `json:"priority,omitempty"`
	Tags      map[string]string `json:"tags,omitempty"`
}

// State 是给管理面看的运行期状态：只有计数与 revision，没有令牌。
type State struct {
	Ready      bool      `json:"ready"`
	Revision   string    `json:"revision"`
	Generation string    `json:"generation,omitempty"`
	Accounts   int       `json:"accounts"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Result 是 Replace 的返回，同样不含秘密。
type Result struct {
	Revision  string    `json:"revision"`
	Accounts  int       `json:"accounts"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Error 是稳定错误码的领域错误。Message 不得包含令牌。
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Cache 是不可变快照的原子容器。读路径无锁。
type Cache struct {
	snap atomic.Pointer[cacheSnapshot]
}

type cacheSnapshot struct {
	revision   string
	generation string
	updatedAt  time.Time
	accounts   map[string]Account
	order      []string
}

// New 创建一个空缓存。
func New() *Cache {
	cache := &Cache{}
	cache.snap.Store(&cacheSnapshot{
		revision:  emptyRevision,
		updatedAt: time.Now().UTC(),
		accounts:  map[string]Account{},
	})
	return cache
}

const emptyRevision = "empty"

// Replace 校验并原子替换整份快照。返回的 revision 是内容哈希（不含明文）。
func (c *Cache) Replace(snapshot Snapshot) (Result, error) {
	compiled, err := compile(snapshot)
	if err != nil {
		return Result{}, err
	}
	c.snap.Store(compiled)
	return Result{
		Revision:  compiled.revision,
		Accounts:  len(compiled.order),
		UpdatedAt: compiled.updatedAt,
	}, nil
}

// State 返回不含秘密的计数与版本。
func (c *Cache) State() State {
	snap := c.snap.Load()
	return State{
		Ready:      true,
		Revision:   snap.revision,
		Generation: snap.generation,
		Accounts:   len(snap.order),
		UpdatedAt:  snap.updatedAt,
	}
}

// Credential 返回某个账号的派发材料。令牌过期或账号不存在时返回 false。
func (c *Cache) Credential(accountID string) (contracts.AccountCredential, bool) {
	snap := c.snap.Load()
	account, ok := snap.accounts[accountID]
	if !ok || !usable(account, time.Now()) {
		return contracts.AccountCredential{}, false
	}
	return contracts.AccountCredential{
		AccountID:   account.AccountID,
		Provider:    account.Provider,
		Kind:        account.Kind,
		BaseURL:     account.BaseURL,
		AccessToken: account.Token,
		ExpiresAt:   account.ExpiresAt,
	}, true
}

// Candidates 返回可参与打分的候选快照。不可用账号直接不出现。
func (c *Cache) Candidates() []contracts.AccountCandidate {
	snap := c.snap.Load()
	now := time.Now()
	out := make([]contracts.AccountCandidate, 0, len(snap.order))
	for _, id := range snap.order {
		account := snap.accounts[id]
		if !usable(account, now) {
			continue
		}
		out = append(out, contracts.AccountCandidate{
			AccountID: account.AccountID,
			Provider:  account.Provider,
			Kind:      account.Kind,
			Priority:  account.Priority,
			Health:    contracts.HealthUnknown,
			Tags:      cloneTags(account.Tags),
		})
	}
	return out
}

func usable(account Account, now time.Time) bool {
	if strings.TrimSpace(account.Token) == "" {
		return false
	}
	if account.ExpiresAt != nil && !account.ExpiresAt.After(now.Add(ExpirySafety)) {
		return false
	}
	return true
}

func compile(snapshot Snapshot) (*cacheSnapshot, error) {
	if snapshot.Version != 0 && snapshot.Version != SnapshotVersion {
		return nil, newError("ACCOUNTS_INVALID_SNAPSHOT",
			"不支持的账号快照版本 %d（支持 %d）", snapshot.Version, SnapshotVersion)
	}
	if len(snapshot.Accounts) > MaxAccounts {
		return nil, newError("ACCOUNTS_INVALID_SNAPSHOT",
			"账号快照最多 %d 个，收到 %d 个", MaxAccounts, len(snapshot.Accounts))
	}

	compiled := &cacheSnapshot{
		generation: snapshot.Generation,
		updatedAt:  time.Now().UTC(),
		accounts:   make(map[string]Account, len(snapshot.Accounts)),
		order:      make([]string, 0, len(snapshot.Accounts)),
	}
	for _, account := range snapshot.Accounts {
		if err := validateAccount(account); err != nil {
			return nil, err
		}
		if _, exists := compiled.accounts[account.AccountID]; exists {
			return nil, newError("ACCOUNTS_DUPLICATE_ACCOUNT", "账号 id 重复：%s", account.AccountID)
		}
		account.Tags = cloneTags(account.Tags)
		compiled.accounts[account.AccountID] = account
		compiled.order = append(compiled.order, account.AccountID)
	}
	compiled.revision = revisionOf(compiled.accounts, compiled.order)
	return compiled, nil
}

func validateAccount(account Account) error {
	if strings.TrimSpace(account.AccountID) == "" {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号必须有非空 accountId")
	}
	if strings.TrimSpace(account.Provider) == "" {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 缺少 provider", account.AccountID)
	}
	if account.Kind != "" && account.Kind != "oauth" && account.Kind != "api_key" {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 kind 不合法：%s", account.AccountID, account.Kind)
	}
	if strings.TrimSpace(account.BaseURL) == "" {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 缺少 baseUrl", account.AccountID)
	}
	if len(account.BaseURL) > MaxBaseURLBytes {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 baseUrl 过长", account.AccountID)
	}
	parsed, err := url.Parse(account.BaseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 baseUrl 必须是 http(s) URL", account.AccountID)
	}
	if parsed.User != nil {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 baseUrl 不得包含用户信息", account.AccountID)
	}
	if strings.TrimSpace(account.Token) == "" {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 没有访问令牌", account.AccountID)
	}
	if len(account.Token) > MaxTokenBytes {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的访问令牌过长", account.AccountID)
	}
	if account.ExpiresAt != nil && account.ExpiresAt.IsZero() {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 expiresAt 不合法", account.AccountID)
	}
	return nil
}

// revisionOf 对快照内容（含令牌）做哈希。只输出哈希，不输出令牌。
func revisionOf(accounts map[string]Account, order []string) string {
	hash := sha256.New()
	for _, id := range order {
		account := accounts[id]
		fmt.Fprintf(hash, "%s\x00%s\x00%s\x00%s\x00", account.AccountID, account.Provider, account.Kind, account.BaseURL)
		hash.Write([]byte(account.Token))
		fmt.Fprintf(hash, "\x00%d\x00", account.Priority)
		if account.ExpiresAt != nil {
			hash.Write([]byte(account.ExpiresAt.UTC().Format(time.RFC3339Nano)))
		}
		hash.Write([]byte{0})
		keys := make([]string, 0, len(account.Tags))
		for key := range account.Tags {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			hash.Write([]byte(key))
			hash.Write([]byte{0})
			hash.Write([]byte(account.Tags[key]))
			hash.Write([]byte{0})
		}
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))[:16]
}

func cloneTags(tags map[string]string) map[string]string {
	if len(tags) == 0 {
		return nil
	}
	out := make(map[string]string, len(tags))
	for key, value := range tags {
		out[key] = value
	}
	return out
}
