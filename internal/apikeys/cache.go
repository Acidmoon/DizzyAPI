// Package apikeys 是 Go 侧的 API key 只读哈希快照缓存。
//
// 权威数据在 TS 的 api-key 插件（SQLite）；它经控制桥把「enabled 且用户可用」的
// key 的 sha256 哈希整份推过来。本包只校验、原子替换、在内存里做常量时间校验。
// 它不读 TS 的 SQLite 文件，不保存明文或掩码，也不把哈希写进日志 / HTTP / 桥响应。
package apikeys

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// SnapshotVersion 是桥消息里的快照版本。只接受 1。
	SnapshotVersion = 1
	// MaxKeys 一份快照最多容纳的 key 数。
	MaxKeys = 1_000_000
	// MaxKeyIDBytes / MaxProfileBytes / MaxNameBytes 是字段长度上限。
	MaxKeyIDBytes   = 128
	MaxProfileBytes = 64
	MaxNameBytes    = 256
	// MaxConcurrencyLimit 是单个 key 的并发上限上界；超过它视为配置错误（整份快照拒绝）。
	MaxConcurrencyLimit = 100_000
)

// 稳定错误码；桥会原样转发。
const (
	CodeInvalidSnapshot = "KEYS_INVALID_SNAPSHOT"
	CodeInvalidKey      = "KEYS_INVALID_KEY"
	CodeDuplicateKey    = "KEYS_DUPLICATE_KEY"
)

const emptyRevision = "empty"

// Snapshot 是 TS 推来的完整 key 快照。任何一条不合法就整份拒绝，绝不部分应用。
type Snapshot struct {
	Version    int   `json:"version"`
	Generation int64 `json:"generation"`
	Keys       []Key `json:"keys"`
}

// Key 是快照里的一条记录。KeyHash 是完整 key 的 sha256 hex（64 字符）。
//
// 三个上限是**纯增量**字段（旧快照缺省 = 不限）：它们只用于 key-gate 的 pre 相位判定，
// 不参与校验哈希，也不进任何日志。金额一律十进制微元字符串（JSON number 会丢精度）。
type Key struct {
	KeyID   string `json:"keyId"`
	UserID  int64  `json:"userId"`
	KeyHash string `json:"keyHash"`
	Profile string `json:"profile"`
	Name    string `json:"name"`

	// ExpiresAt 是 RFC3339 时间；空 = 永不过期。
	ExpiresAt string `json:"expiresAt,omitempty"`
	// SpendingLimitMicros 是十进制整数微元；空 = 不限。
	SpendingLimitMicros string `json:"spendingLimitMicros,omitempty"`
	// ConcurrencyLimit 是并发上限；0 / 缺省 = 不限。
	ConcurrencyLimit int `json:"concurrencyLimit,omitempty"`
}

// compiledKey 是校验并解析过的 key：热路径（Verify）不做字符串解析。
type compiledKey struct {
	Key
	expiresAt           *time.Time
	spendingLimitMicros *int64
}

// Result 是 Replace 的返回，不含任何哈希。
type Result struct {
	Revision  string    `json:"revision"`
	Keys      int       `json:"keys"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Status 是给管理面看的运行期状态，同样不含哈希。
type Status struct {
	Revision  string    `json:"revision"`
	Keys      int       `json:"keys"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Error 是稳定错误码的领域错误。Message 不得包含 key 或哈希。
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Cache 是不可变快照的原子容器。读路径无锁；写路径用互斥锁串行化。
type Cache struct {
	mu   sync.Mutex
	snap atomic.Pointer[cacheSnapshot]
}

type cacheSnapshot struct {
	revision   string
	generation int64
	updatedAt  time.Time
	// ready 表示是否已经收到过至少一份合法的 keys.replace 快照。
	// 它与 len(keys) 分开：合法的空快照也是 ready，必须 fail-closed。
	ready  bool
	keys   []compiledKey
	byHash map[string]compiledKey
}

// New 创建一个尚未收到快照的空缓存。
func New() *Cache {
	cache := &Cache{}
	cache.snap.Store(&cacheSnapshot{
		revision:  emptyRevision,
		updatedAt: time.Now().UTC(),
		ready:     false,
		keys:      []compiledKey{},
		byHash:    map[string]compiledKey{},
	})
	return cache
}

// Replace 校验并原子替换整份快照。返回的 revision 是内容哈希（不含明文）。
//
// 整段（校验 + 替换）都在互斥锁里：并发写者按进入顺序串行化，
// 不会出现「旧快照后写、把新快照覆盖掉」。
func (c *Cache) Replace(snapshot Snapshot) (Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	compiled, err := compile(snapshot)
	if err != nil {
		return Result{}, err
	}
	c.snap.Store(compiled)

	return Result{
		Revision:  compiled.revision,
		Keys:      len(compiled.keys),
		UpdatedAt: compiled.updatedAt,
	}, nil
}

// Count 返回当前快照里的 key 数，只用于展示与日志。
func (c *Cache) Count() int {
	return len(c.snap.Load().keys)
}

// Ready 表示是否已经收到过至少一份合法的 keys.replace 快照。
//
// key-auth 用它判断是否启用动态 key 模式。合法的空快照也是 Ready，
// 此时 Count==0 且 Verify 永远 false——不允许退回静态 key / 占位模式。
func (c *Cache) Ready() bool {
	return c.snap.Load().ready
}

// Status 返回不含秘密的计数与版本。
func (c *Cache) Status() Status {
	snap := c.snap.Load()
	return Status{
		Revision:  snap.revision,
		Keys:      len(snap.keys),
		UpdatedAt: snap.updatedAt,
	}
}

// Verify 校验一个完整 key。
//
// 先算 sha256 hex，再查哈希快照，并用常量时间比较确认命中。空 key 直接 false。
// 不存在与校验失败不区分，调用方只能得到 (zero, false)。
func (c *Cache) Verify(presented string) (contracts.APIKeyRecord, bool) {
	if presented == "" {
		return contracts.APIKeyRecord{}, false
	}

	snap := c.snap.Load()
	// 还没收到过快照时不做任何猜测；调用方会走启动/降级路径。
	if !snap.ready {
		return contracts.APIKeyRecord{}, false
	}
	// 已收到合法空快照：明确拒绝全部 key（fail-closed），不是「谁都能进」。
	if len(snap.keys) == 0 {
		return contracts.APIKeyRecord{}, false
	}

	sum := sha256.Sum256([]byte(presented))
	digest := hex.EncodeToString(sum[:])
	key, found := snap.byHash[digest]

	// 未命中时也与一串 0 做同样长度的比较，避免「是否存在」在比较耗时上明显不同。
	candidate := make([]byte, hex.EncodedLen(sha256.Size))
	if found {
		copy(candidate, key.KeyHash)
	}
	if subtle.ConstantTimeCompare(candidate, []byte(digest)) != 1 || !found {
		return contracts.APIKeyRecord{}, false
	}

	return contracts.APIKeyRecord{
		KeyID:               key.KeyID,
		UserID:              strconv.FormatInt(key.UserID, 10),
		Name:                key.Name,
		Profile:             key.Profile,
		ExpiresAt:           key.expiresAt,
		SpendingLimitMicros: key.spendingLimitMicros,
		ConcurrencyLimit:    key.ConcurrencyLimit,
	}, true
}

func compile(snapshot Snapshot) (*cacheSnapshot, error) {
	if snapshot.Version != SnapshotVersion {
		return nil, newError(CodeInvalidSnapshot,
			"不支持的 API key 快照版本 %d（只接受 %d）", snapshot.Version, SnapshotVersion)
	}
	if snapshot.Generation < 0 {
		return nil, newError(CodeInvalidSnapshot, "generation 不能为负数：%d", snapshot.Generation)
	}
	if len(snapshot.Keys) > MaxKeys {
		return nil, newError(CodeInvalidSnapshot,
			"API key 快照最多 %d 个，收到 %d 个", MaxKeys, len(snapshot.Keys))
	}

	compiled := &cacheSnapshot{
		generation: snapshot.Generation,
		updatedAt:  time.Now().UTC(),
		// 任何通过校验的快照（包括空快照）都算「已收到」，
		// 从这一刻起 key-auth 只认快照，拒绝回退。
		ready:  true,
		keys:   make([]compiledKey, 0, len(snapshot.Keys)),
		byHash: make(map[string]compiledKey, len(snapshot.Keys)),
	}
	ids := make(map[string]struct{}, len(snapshot.Keys))
	for _, key := range snapshot.Keys {
		normalized, err := validateKey(key)
		if err != nil {
			return nil, err
		}
		if _, exists := ids[normalized.KeyID]; exists {
			return nil, newError(CodeDuplicateKey, "keyId 重复：%s", normalized.KeyID)
		}
		if _, exists := compiled.byHash[normalized.KeyHash]; exists {
			return nil, newError(CodeDuplicateKey, "keyHash 重复：%s", normalized.KeyID)
		}
		ids[normalized.KeyID] = struct{}{}
		compiled.byHash[normalized.KeyHash] = normalized
		compiled.keys = append(compiled.keys, normalized)
	}
	compiled.revision = revisionOf(compiled.generation, compiled.keys)
	return compiled, nil
}

func validateKey(key Key) (compiledKey, error) {
	if strings.TrimSpace(key.KeyID) == "" {
		return compiledKey{}, newError(CodeInvalidKey, "key 必须有非空 keyId")
	}
	if len(key.KeyID) > MaxKeyIDBytes {
		return compiledKey{}, newError(CodeInvalidKey, "keyId 过长（上限 %d 字节）", MaxKeyIDBytes)
	}
	if key.UserID <= 0 {
		return compiledKey{}, newError(CodeInvalidKey, "key %s 的 userId 必须是正整数", key.KeyID)
	}
	if strings.TrimSpace(key.Profile) == "" {
		return compiledKey{}, newError(CodeInvalidKey, "key %s 缺少 profile", key.KeyID)
	}
	if len(key.Profile) > MaxProfileBytes {
		return compiledKey{}, newError(CodeInvalidKey, "key %s 的 profile 过长", key.KeyID)
	}
	if len(key.Name) > MaxNameBytes {
		return compiledKey{}, newError(CodeInvalidKey, "key %s 的 name 过长", key.KeyID)
	}

	hash := strings.TrimSpace(key.KeyHash)
	if len(hash) != hex.EncodedLen(sha256.Size) {
		return compiledKey{}, newError(CodeInvalidKey, "key %s 的 keyHash 必须是 64 位 hex", key.KeyID)
	}
	if _, err := hex.DecodeString(hash); err != nil {
		return compiledKey{}, newError(CodeInvalidKey, "key %s 的 keyHash 不是合法 hex", key.KeyID)
	}
	key.KeyHash = strings.ToLower(hash)

	compiled := compiledKey{Key: key}
	if raw := strings.TrimSpace(key.ExpiresAt); raw != "" {
		expiresAt, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return compiledKey{}, newError(CodeInvalidKey, "key %s 的 expiresAt 不是 RFC3339 时间：%q", key.KeyID, raw)
		}
		utc := expiresAt.UTC()
		compiled.expiresAt = &utc
	}
	if raw := strings.TrimSpace(key.SpendingLimitMicros); raw != "" {
		micros, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || micros <= 0 {
			// 金额绝不经过浮点；解析失败即整份快照被拒（fail-closed，不是「按不限处理」）。
			return compiledKey{}, newError(CodeInvalidKey,
				"key %s 的 spendingLimitMicros 必须是正十进制整数微元：%q", key.KeyID, raw)
		}
		compiled.spendingLimitMicros = &micros
	}
	if key.ConcurrencyLimit < 0 || key.ConcurrencyLimit > MaxConcurrencyLimit {
		return compiledKey{}, newError(CodeInvalidKey,
			"key %s 的 concurrencyLimit 必须在 0..%d 之间（0 = 不限）", key.KeyID, MaxConcurrencyLimit)
	}
	return compiled, nil
}

// revisionOf 对快照内容做哈希。只输出 revision，不输出任何 key 哈希。
//
// 三个上限也参与哈希：只改上限（不改哈希）时才推的新快照必须得到不同的 revision，
// 否则 Go 侧会把「上限变了」当成同内容重推。
func revisionOf(generation int64, keys []compiledKey) string {
	hash := sha256.New()
	fmt.Fprintf(hash, "v%d\x00%d\x00", SnapshotVersion, generation)
	for _, key := range keys {
		fmt.Fprintf(hash, "%s\x00%d\x00%s\x00%s\x00%s\x00%s\x00%s\x00%d\x00",
			key.KeyID, key.UserID, key.KeyHash, key.Profile, key.Name,
			key.ExpiresAt, key.SpendingLimitMicros, key.ConcurrencyLimit)
	}
	return hex.EncodeToString(hash.Sum(nil))[:16]
}
