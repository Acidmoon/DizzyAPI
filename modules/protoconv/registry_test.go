package protoconv

import (
	"testing"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

func TestRegistryRejectsDuplicate(t *testing.T) {
	registry := contracts.NewCodecRegistry()
	if err := registry.Register(fakeCodec{protocol: contracts.ProtocolOpenAIChat}); err != nil {
		t.Fatalf("首次注册应成功：%v", err)
	}
	if err := registry.Register(fakeCodec{protocol: contracts.ProtocolOpenAIChat}); err == nil {
		t.Fatal("重复注册必须报错")
	}
}

func TestRegistryRejectsNilAndEmptyProtocol(t *testing.T) {
	registry := contracts.NewCodecRegistry()
	if err := registry.Register(nil); err == nil {
		t.Fatal("nil codec 必须报错")
	}
	if err := registry.Register(fakeCodec{protocol: ""}); err == nil {
		t.Fatal("空协议必须报错")
	}
}

func TestRegistryLookupAndProtocols(t *testing.T) {
	registry := contracts.NewCodecRegistry()
	_ = registry.Register(fakeCodec{protocol: contracts.ProtocolOpenAIChat})
	_ = registry.Register(fakeCodec{protocol: contracts.ProtocolAnthropic})

	if _, ok := registry.Lookup(contracts.ProtocolGemini); ok {
		t.Fatal("未注册协议不应命中")
	}
	if codec, ok := registry.Lookup(contracts.ProtocolAnthropic); !ok || codec.Protocol() != contracts.ProtocolAnthropic {
		t.Fatal("已注册协议应命中")
	}
	protocols := registry.Protocols()
	if len(protocols) != 2 || protocols[0] != contracts.ProtocolAnthropic || protocols[1] != contracts.ProtocolOpenAIChat {
		t.Fatalf("协议列表应稳定排序：%v", protocols)
	}
}

func TestNewRequiresDependencies(t *testing.T) {
	if _, err := New(nil, fakeCreds{}, nil); err == nil {
		t.Fatal("codec 注册表不能为空")
	}
	if _, err := New(contracts.NewCodecRegistry(), nil, nil); err == nil {
		t.Fatal("凭据源不能为空")
	}
}
