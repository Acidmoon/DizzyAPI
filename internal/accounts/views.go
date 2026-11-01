package accounts

import (
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// 把内存快照映射成**消费者要的形状**：transport 要的派发材料（`Credential`）与
// 打分模块要的候选（`Candidates`）。
//
// 从 `cache.go` 拆出来的原因：那个文件贴着 §5.6 的 500 行上限，而这里只做「字段挑选与透传」，
// 和「装载 / 校验 / 原子替换」是两件事。透传纪律：**少透传一个字段，下游的实现就是死数据**，
// 所以这段代码的每个字段都要有下游消费者。

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
		// 客户端指纹：模板原样带出去（展开在 transport，需要请求体）。
		ClientHeaders:   cloneAccountHeaders(account.ClientHeaders),
		ClientUserAgent: account.ClientUserAgent,
	}, true
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
			// 排障用：能看出这个账号在伪装成谁（真正套用在 transport，取 Credential 那份）。
			ClientHeaders:   cloneAccountHeaders(account.ClientHeaders),
			ClientUserAgent: account.ClientUserAgent,
		})
	}
	return out
}
