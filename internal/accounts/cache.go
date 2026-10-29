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
	"math"
	"net/url"
	"sort"
	"strconv"
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
	// MaxModels 单个账号最多声明的对外模型名数。
	MaxModels = 256
	// MaxModelMapEntries 单个账号 modelMap 的最多映射条数。
	MaxModelMapEntries = 256
	// MaxModelNameBytes 单个模型名（或 modelMap 键 / 值）的长度上限。
	MaxModelNameBytes = 256
	// ExpirySafety 是「即将过期」的提前量；低于它的令牌不再参与选择。
	ExpirySafety = 30 * time.Second
	// MaxConcurrency 是单个账号并发上限的上限（与 TS 侧 identity 的校验口径一致）。
	MaxConcurrency = 10_000
	// MaxWeight 是账号权重的上限（与 TS 侧 identity 的校验口径一致）。
	MaxWeight = 1_000_000.0
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
	// Weight 是账号声明的权重（> 0）。用指针表达「未声明」与「已知值」的区别：
	// 空 = 旧快照没这个字段，必须合法（打分时按未知处理）。
	Weight *float64 `json:"weight,omitempty"`
	// Concurrency 是账号级并发上限；0 = 未声明（不是「并发为 0」）。
	Concurrency int `json:"concurrency,omitempty"`
	// Health 是账号健康状态；空 = 未声明，转成 contracts.HealthUnknown 透传。
	Health string `json:"health,omitempty"`
	// Protocol 是账号声明的上游协议。空 = 旧快照（未声明），合法。
	Protocol string `json:"protocol,omitempty"`
	// Models 是这个账号服务的对外模型名；ModelMap 是「对外模型名 → 上游真实模型名」。
	// 空 = 旧快照（未声明），合法：不参与模型路由过滤、不做模型映射。
	Models   []string          `json:"models,omitempty"`
	ModelMap map[string]string `json:"modelMap,omitempty"`
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
		Protocol:    account.Protocol,
		Models:      cloneStrings(account.Models),
		ModelMap:    cloneModelMap(account.ModelMap),
	}, true
}

// Models 返回当前所有可用账号声明的对外模型名的并集，去重并按字典序稳定排序。
//
// 未声明 Models 的账号不贡献任何模型名；不可用（令牌缺失 / 即将过期）的账号被跳过。
// 它只返回模型名，绝不返回账号 id、baseUrl 或令牌。
func (c *Cache) Models() []string {
	snap := c.snap.Load()
	now := time.Now()
	seen := make(map[string]struct{})
	for _, id := range snap.order {
		account := snap.accounts[id]
		if !usable(account, now) {
			continue
		}
		for _, model := range account.Models {
			if model != "" {
				seen[model] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(seen))
	for model := range seen {
		out = append(out, model)
	}
	sort.Strings(out)
	return out
}

// Candidates 返回可参与打分的候选快照。不可用账号直接不出现。
//
// weight / concurrency / health / tags 全部从快照透传：调度模块早就实现了按标签与
// 健康状态过滤、按权重与并发容量打分，这里少透传一个字段，那些实现就是死数据。
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
			AccountID:   account.AccountID,
			Provider:    account.Provider,
			Kind:        account.Kind,
			Priority:    account.Priority,
			Weight:      account.Weight,
			Concurrency: account.Concurrency,
			Health:      healthStateOf(account.Health),
			Tags:        cloneTags(account.Tags),
			Models:      cloneStrings(account.Models),
		})
	}
	return out
}

// healthStateOf 把快照里的健康状态透传给评分层；空（旧快照 / 未声明）是
// contracts.HealthUnknown——未知是一等状态，不是「默认健康」（AGENTS.md D17）。
func healthStateOf(health string) contracts.HealthState {
	if health == "" {
		return contracts.HealthUnknown
	}
	return contracts.HealthState(health)
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
		account.Models = cloneStrings(account.Models)
		account.ModelMap = cloneModelMap(account.ModelMap)
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
	if account.Protocol != "" && !validProtocol(account.Protocol) {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 protocol 不合法：%s", account.AccountID, account.Protocol)
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
	if err := validateWeight(account.AccountID, account.Weight); err != nil {
		return err
	}
	if account.Concurrency < 0 {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 concurrency 不能为负数", account.AccountID)
	}
	if account.Concurrency > MaxConcurrency {
		return newError("ACCOUNTS_INVALID_ACCOUNT",
			"账号 %s 的 concurrency 最多 %d，收到 %d", account.AccountID, MaxConcurrency, account.Concurrency)
	}
	if account.Health != "" && !validHealth(account.Health) {
		return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 health 不合法：%s", account.AccountID, account.Health)
	}
	if err := validateModels(account.AccountID, account.Models); err != nil {
		return err
	}
	if err := validateModelMap(account.AccountID, account.ModelMap); err != nil {
		return err
	}
	return nil
}

// validateModels 校验对外模型名列表。空列表合法（未声明 = 不参与路由过滤）。
func validateModels(accountID string, models []string) error {
	if len(models) > MaxModels {
		return newError("ACCOUNTS_INVALID_ACCOUNT",
			"账号 %s 的 models 最多 %d 个，收到 %d 个", accountID, MaxModels, len(models))
	}
	for _, model := range models {
		if strings.TrimSpace(model) == "" {
			return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 models 含空模型名", accountID)
		}
		if len(model) > MaxModelNameBytes {
			return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的模型名过长（上限 %d 字节）", accountID, MaxModelNameBytes)
		}
		if hasControlChar(model) {
			return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的模型名含控制字符", accountID)
		}
	}
	return nil
}

// validateModelMap 校验「对外模型名 → 上游模型名」映射。空映射合法。
func validateModelMap(accountID string, mapping map[string]string) error {
	if len(mapping) > MaxModelMapEntries {
		return newError("ACCOUNTS_INVALID_ACCOUNT",
			"账号 %s 的 modelMap 最多 %d 条，收到 %d 条", accountID, MaxModelMapEntries, len(mapping))
	}
	for key, value := range mapping {
		if strings.TrimSpace(key) == "" {
			return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 modelMap 含空键", accountID)
		}
		if strings.TrimSpace(value) == "" {
			return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 modelMap 值不能为空（键 %q）", accountID, key)
		}
		if len(key) > MaxModelNameBytes || len(value) > MaxModelNameBytes {
			return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 modelMap 键值过长（上限 %d 字节）", accountID, MaxModelNameBytes)
		}
		if hasControlChar(key) || hasControlChar(value) {
			return newError("ACCOUNTS_INVALID_ACCOUNT", "账号 %s 的 modelMap 键值含控制字符", accountID)
		}
	}
	return nil
}

// hasControlChar 报告字符串是否含控制字符（含 DEL）。模型名不应带控制字符。
func hasControlChar(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// validProtocol 是账号上游协议的白名单。空串合法（旧快照兼容）。
func validProtocol(protocol string) bool {
	switch protocol {
	case string(contracts.ProtocolOpenAIChat),
		string(contracts.ProtocolOpenAIResponses),
		string(contracts.ProtocolAnthropic),
		string(contracts.ProtocolGemini):
		return true
	default:
		return false
	}
}

// validateWeight 校验权重：nil 合法（未声明）；否则必须是大于 0 的有限数值。
// 0 不是「无权重」，是非法值——不能让它悄悄变成评分里的 0 分。
func validateWeight(accountID string, weight *float64) error {
	if weight == nil {
		return nil
	}
	value := *weight
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 || value > MaxWeight {
		return newError("ACCOUNTS_INVALID_ACCOUNT",
			"账号 %s 的 weight 必须是 (0, %g] 的有限数值", accountID, MaxWeight)
	}
	return nil
}

// validHealth 是健康状态的白名单，与 contracts.HealthState 一一对应。空串合法（旧快照）。
func validHealth(health string) bool {
	switch contracts.HealthState(health) {
	case contracts.HealthUnknown,
		contracts.HealthHealthy,
		contracts.HealthDegraded,
		contracts.HealthUnhealthy:
		return true
	default:
		return false
	}
}

// revisionOf 对快照内容（含令牌）做哈希。只输出哈希，不输出令牌。
func revisionOf(accounts map[string]Account, order []string) string {
	hash := sha256.New()
	for _, id := range order {
		account := accounts[id]
		fmt.Fprintf(hash, "%s\x00%s\x00%s\x00%s\x00", account.AccountID, account.Provider, account.Kind, account.BaseURL)
		hash.Write([]byte(account.Token))
		fmt.Fprintf(hash, "\x00%s\x00", account.Protocol)
		fmt.Fprintf(hash, "\x00%d\x00", account.Priority)
		// weight / concurrency / health 也进内容哈希：只改权重也必须换 revision，
		// 否则诊断与「快照变了没有」的判断都会失真。
		hash.Write([]byte{0})
		if account.Weight != nil {
			hash.Write([]byte(strconv.FormatFloat(*account.Weight, 'g', -1, 64)))
		}
		hash.Write([]byte{0})
		fmt.Fprintf(hash, "%d\x00%s\x00", account.Concurrency, account.Health)
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
		// models：按原顺序进哈希（内容变化即 revision 变化）。
		for _, model := range account.Models {
			hash.Write([]byte(model))
			hash.Write([]byte{0})
		}
		hash.Write([]byte{0})
		// modelMap：键排序保证稳定。
		modelKeys := make([]string, 0, len(account.ModelMap))
		for key := range account.ModelMap {
			modelKeys = append(modelKeys, key)
		}
		sort.Strings(modelKeys)
		for _, key := range modelKeys {
			hash.Write([]byte(key))
			hash.Write([]byte{0})
			hash.Write([]byte(account.ModelMap[key]))
			hash.Write([]byte{0})
		}
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))[:16]
}

func cloneStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	out := make([]string, len(values))
	copy(out, values)
	return out
}

func cloneModelMap(mapping map[string]string) map[string]string {
	if len(mapping) == 0 {
		return nil
	}
	out := make(map[string]string, len(mapping))
	for key, value := range mapping {
		out[key] = value
	}
	return out
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
