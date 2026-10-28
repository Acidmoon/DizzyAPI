// Package usagelog 是 Go 侧的用量环形缓冲（AGENTS.md §2.4 / §4.2）。
//
// 它只保存「已完成的 LLM 请求」的用量事实，不做计费、不落盘。TS 的 usage 插件
// 每 pollIntervalMs 经控制桥调用 usage.since 拉取新记录并幂等落库。
//
// 设计要点：
//   - Append 在 LLM 请求的返回路径上，必须非阻塞：满了丢最旧，并累加 dropped；
//     其中「从没被 reader 取走就被覆盖」的部分单独记成 gap（真丢的数据）。
//   - Seq 由缓冲分配，进程内从 1 递增；Epoch 标识一次进程生命周期，
//     gatewayd 重启后 TS 据此重置游标；
//   - Since 返回的 SinceResult 与 TS 的 UsageSinceResult 同名同形（camelCase）；
//   - Stats 给控制桥的 usage.stats 用：容量 / 占用 / 丢弃 / 缺口 / epoch / lastSeq，
//     让 TS 在断线或回绕时能说清「是缓冲太小还是轮询断了」。
package usagelog

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// DefaultCapacity 是未显式配置时的容量（约 32k 条记录）。
	DefaultCapacity = 32768
	// MinCapacity / MaxCapacity 是容量配置的硬边界。
	//
	// 上限取 1<<20（约 100 万条）：一条 UsageRecord 约 300 字节，满配约 300MB；
	// 再大就是把内存当磁盘用，起不到「短时断线补拉」的作用。
	MinCapacity = 1
	MaxCapacity = 1 << 20
	// MinLimit / MaxLimit 是 Since 对 limit 的硬边界。
	MinLimit = 1
	MaxLimit = 5000
)

// Ring 是有界的用量环形缓冲。零值不可用，请用 NewRing 构造。
type Ring struct {
	mu       sync.Mutex
	capacity int
	records  []contracts.UsageRecord
	head     int
	size     int
	seq      int64
	epoch    string
	dropped  int64
	// delivered 是曾经返回给 reader 的最大 Seq。
	delivered int64
	// gap 是「被覆盖时还没有任何 reader 取走」的累计条数（dropped 里真正丢掉的部分）。
	gap int64
}

// StatsResult 是 usage.stats 的返回：环形缓冲的容量与投递健康度（全是整数）。
//
// Dropped 与 Gap 的区别：读者跟得上时，回绕覆盖的是**已经取走**的记录，只是缓冲 churn；
// 只有覆盖时还没被任何 reader 取走的记录才是真丢。TS 用 Gap 的增长做告警，
// 用 Dropped-Gap 判断「缓冲是否太小」。
type StatsResult struct {
	Epoch    string `json:"epoch"`
	Capacity int    `json:"capacity"`
	Size     int    `json:"size"`
	FirstSeq int64  `json:"firstSeq"`
	// LastSeq 是已分配的最大 Seq（与 SinceResult.LastSeq 同口径）。
	LastSeq int64 `json:"lastSeq"`
	Dropped int64 `json:"dropped"`
	Gap     int64 `json:"gap"`
}

// SinceResult 是 usage.since 的返回。
//
// 字段名与 TS 的 UsageSinceResult 对齐（camelCase）。Records 按 Seq 升序，
// 只包含 seq > afterSeq 的记录；epoch 变化时忽略 afterSeq（让 TS 重置游标）。
type SinceResult struct {
	Epoch    string                  `json:"epoch"`
	FirstSeq int64                   `json:"firstSeq"`
	LastSeq  int64                   `json:"lastSeq"`
	Dropped  int64                   `json:"dropped"`
	Records  []contracts.UsageRecord `json:"records"`
}

// NewRing 创建容量为 capacity 的缓冲。
//
// 容量非法（不在 [MinCapacity, MaxCapacity] 内）时返回错误，**不**回落到默认值：
// 容量是启动参数，静默回落会让「配置写错」看起来像「配置生效」（AGENTS.md §2.4.5）。
// Epoch 每次构造都重新生成（8 字节 crypto/rand 的 hex）。
func NewRing(capacity int) (*Ring, error) {
	if capacity < MinCapacity || capacity > MaxCapacity {
		return nil, fmt.Errorf(
			"用量环形缓冲容量必须在 %d..%d 之间，得到 %d",
			MinCapacity, MaxCapacity, capacity,
		)
	}
	return &Ring{
		capacity: capacity,
		records:  make([]contracts.UsageRecord, capacity),
		epoch:    newEpoch(),
	}, nil
}

func newEpoch() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return hex.EncodeToString(raw[:])
	}
	// crypto/rand 在正常平台上不会失败；这里只保证 NewRing 永远有非空 epoch。
	return fmt.Sprintf("%016x", time.Now().UnixNano())
}

// Append 写入一条记录，并分配 Seq / Epoch。
//
// 缓冲满时覆盖最旧记录并累加 dropped。它只持有一把短锁，不阻塞在 I/O 上。
func (r *Ring) Append(record contracts.UsageRecord) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	r.seq++
	record.Seq = r.seq
	record.Epoch = r.epoch

	if r.size == r.capacity {
		// 覆盖最旧的一条。它如果从没被任何 reader 取走，就是真丢，单独累计。
		if r.records[r.head].Seq > r.delivered {
			r.gap++
		}
		r.records[r.head] = record
		r.head = (r.head + 1) % r.capacity
		r.dropped++
		return
	}
	r.records[(r.head+r.size)%r.capacity] = record
	r.size++
}

// Since 返回 seq > afterSeq 的记录，最多 limit 条。
//
//   - epoch 与当前不同：忽略 afterSeq，从缓冲最旧的一条开始返回（TS 重置游标）；
//   - limit 会被 clamp 到 [MinLimit, MaxLimit]；
//   - 缓冲为空时 FirstSeq == LastSeq == 0。缓冲非空但没有新记录时，
//     FirstSeq / LastSeq 仍是缓冲边界，Records 为空。
func (r *Ring) Since(epoch string, afterSeq int64, limit int) SinceResult {
	if r == nil {
		return SinceResult{}
	}
	limit = clampLimit(limit)

	r.mu.Lock()
	defer r.mu.Unlock()

	result := SinceResult{
		Epoch:   r.epoch,
		Dropped: r.dropped,
		Records: make([]contracts.UsageRecord, 0, min(limit, r.size)),
	}
	if r.size > 0 {
		result.FirstSeq = r.records[r.head].Seq
		result.LastSeq = r.records[(r.head+r.size-1)%r.capacity].Seq
	}
	if epoch != r.epoch {
		afterSeq = 0
	}
	for index := 0; index < r.size && len(result.Records) < limit; index++ {
		record := r.records[(r.head+index)%r.capacity]
		if record.Seq > afterSeq {
			result.Records = append(result.Records, record)
			if record.Seq > r.delivered {
				r.delivered = record.Seq
			}
		}
	}
	return result
}

// Epoch 返回当前进程的 epoch。
func (r *Ring) Epoch() string {
	if r == nil {
		return ""
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.epoch
}

// LastSeq 返回已分配的最大 Seq（没有记录时为 0）。
func (r *Ring) LastSeq() int64 {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.seq
}

// Dropped 返回因回绕丢弃的累计条数。
func (r *Ring) Dropped() int64 {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dropped
}

// Stats 返回只读快照，供控制桥的 usage.stats 给 TS 做告警。
//
// 它不推进任何状态：多次调用结果一致（直到下一次 Append / Since）。
func (r *Ring) Stats() StatsResult {
	if r == nil {
		return StatsResult{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	result := StatsResult{
		Epoch:    r.epoch,
		Capacity: r.capacity,
		Size:     r.size,
		LastSeq:  r.seq,
		Dropped:  r.dropped,
		Gap:      r.gap,
	}
	if r.size > 0 {
		result.FirstSeq = r.records[r.head].Seq
	}
	return result
}

func clampLimit(limit int) int {
	if limit < MinLimit {
		return MinLimit
	}
	if limit > MaxLimit {
		return MaxLimit
	}
	return limit
}
