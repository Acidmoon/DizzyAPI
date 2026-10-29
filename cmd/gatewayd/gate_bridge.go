package main

import (
	"encoding/json"
	"errors"

	"github.com/Acidmoon/DizzyAPI/contracts"
	"github.com/Acidmoon/DizzyAPI/internal/apikeys"
	"github.com/Acidmoon/DizzyAPI/internal/bridge"
	"github.com/Acidmoon/DizzyAPI/internal/keyspend"
	pricingcache "github.com/Acidmoon/DizzyAPI/internal/pricing"
)

// 本文件是**闸门侧的桥命令与状态响应**：价格快照、key 消费快照的推送与查询，
// 以及 key 快照状态里的闸门计数。
//
// 装配（缓存与阶段的创建）见 `gate_wiring.go`；命令行配置见 `gate_config.go`。

// keysStatus 是桥命令 keys.status 的响应：key 快照健康度原样保留，
// 只增一个 gate 字段（key 级执行面闸门的计数）。
//
// gate 是**只增不改**的字段（omitempty）：没有注入闸门阶段（测试 / 旧装配）时不出现，
// 响应与改动前逐字节一致。它不含任何 key 级明细。
type keysStatus struct {
	apikeys.Status
	Gate *keyGateState `json:"gate,omitempty"`
}

// keyGateState 是 key 级执行面闸门的计数（不含 key id、余额或金额明细）。
type keyGateState struct {
	Expired                int `json:"expired,omitempty"`
	SpendingBlocked        int `json:"spendingBlocked,omitempty"`
	SpendingUnknown        int `json:"spendingUnknown,omitempty"`
	ConcurrencyBlocked     int `json:"concurrencyBlocked,omitempty"`
	UserConcurrencyBlocked int `json:"userConcurrencyBlocked,omitempty"`
	ActiveKeys             int `json:"activeKeys,omitempty"`
	ActiveUsers            int `json:"activeUsers,omitempty"`
}

func (h *handler) keysStatus() keysStatus {
	state := keysStatus{Status: h.keys.Status()}
	if h.gates == nil || h.gates.keyGate == nil {
		return state
	}
	stats := h.gates.keyGate.Stats()
	gate := keyGateState{
		Expired:                stats.Expired,
		SpendingBlocked:        stats.SpendingBlocked,
		SpendingUnknown:        stats.SpendingUnknown,
		ConcurrencyBlocked:     stats.ConcurrencyBlocked,
		UserConcurrencyBlocked: stats.UserConcurrencyBlocked,
	}
	if h.gates.keyLimits != nil {
		summary := h.gates.keyLimits.Summary()
		gate.ActiveKeys = summary.ActiveKeys
		gate.ActiveUsers = summary.ActiveUsers
	}
	state.Gate = &gate
	return state
}

// pricingStatus 是桥命令 pricing.status 的响应：价格快照健康度 + 定价闸门计数。
//
// gate 是只增字段（omitempty）：闸门关闭（没装阶段）时不出现。
func (h *handler) pricingStatus() pricingcache.State {
	var state pricingcache.State
	if h.gates == nil {
		return state
	}
	if h.gates.pricingCache != nil {
		state = h.gates.pricingCache.State()
	}
	if h.gates.pricingGate == nil {
		return state
	}
	stats := h.gates.pricingGate.Stats()
	state.Gate = &pricingcache.GateState{
		Blocked:       stats.Blocked,
		StrictBlocked: stats.StrictBlocked,
		Allowed:       stats.Allowed,
		StaleStreak:   stats.StaleStreak,
	}
	return state
}

// handleGateBridge 处理闸门相关的桥命令（价格快照与 key 消费快照的推送 / 查询）。
//
// 返回 handled=false 表示「这个方法不是闸门命令」，交给主 switch 继续。
// 这样闸门命令的代码不必塞进 main.go 那个已经很长的 switch 里。
func (h *handler) handleGateBridge(method string, params json.RawMessage) (any, bool, error) {
	switch method {
	case contracts.BridgeMethodPricingReplace:
		if h.gates == nil || h.gates.pricingCache == nil {
			return nil, true, bridge.Errorf("PRICING_UNAVAILABLE", "价格快照缓存未装配")
		}
		var snapshot pricingcache.Snapshot
		if err := decodeParams(params, &snapshot); err != nil {
			return nil, true, bridge.Errorf("BRIDGE_BAD_REQUEST", "价格快照参数不合法：%v", err)
		}
		result, err := h.gates.pricingCache.Replace(snapshot)
		if err != nil {
			var typed *pricingcache.Error
			if errors.As(err, &typed) {
				return nil, true, bridge.Errorf(typed.Code, "%s", typed.Message)
			}
			return nil, true, bridge.Errorf("PRICING_INVALID_SNAPSHOT", "价格快照更新失败")
		}
		// 只记版本与计数：价格明细不进日志（它是运营数据，不是秘密，但没必要落）。
		h.logger.Info("价格快照已更新",
			"revision", result.Revision, "prices", result.Prices,
			"wildcard", result.Wildcard, "generation", result.Generation)
		return result, true, nil

	case contracts.BridgeMethodPricingStatus:
		return h.pricingStatus(), true, nil

	case contracts.BridgeMethodKeySpendReplace:
		if h.gates == nil || h.gates.spend == nil {
			return nil, true, bridge.Errorf("KEYSPEND_UNAVAILABLE", "key 消费快照缓存未装配")
		}
		var snapshot keyspend.Snapshot
		if err := decodeParams(params, &snapshot); err != nil {
			return nil, true, bridge.Errorf("BRIDGE_BAD_REQUEST", "key 消费快照参数不合法：%v", err)
		}
		result, err := h.gates.spend.Replace(snapshot)
		if err != nil {
			var typed *keyspend.Error
			if errors.As(err, &typed) {
				return nil, true, bridge.Errorf(typed.Code, "%s", typed.Message)
			}
			return nil, true, bridge.Errorf("KEYSPEND_INVALID_SNAPSHOT", "key 消费快照更新失败")
		}
		// 只记版本与计数：金额明细不进日志。
		h.logger.Info("key 消费快照已更新",
			"revision", result.Revision, "entries", result.Entries, "generation", result.Generation)
		return result, true, nil

	case contracts.BridgeMethodKeySpendStatus:
		if h.gates == nil || h.gates.spend == nil {
			return keyspend.State{}, true, nil
		}
		return h.gates.spend.State(), true, nil

	default:
		return nil, false, nil
	}
}
