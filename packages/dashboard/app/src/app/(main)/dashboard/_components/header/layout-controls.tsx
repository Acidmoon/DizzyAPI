"use client";

import { Settings } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fontOptions } from "@/lib/fonts/registry";
import { PREFERENCE_REGISTRY } from "@/lib/preferences/preferences-config";
import { THEME_PRESET_OPTIONS } from "@/lib/preferences/theme";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

export function LayoutControls() {
  const { values, resolvedThemeMode, setPreference, resetPreferences } = usePreferencesStore(
    useShallow((state) => ({
      values: state.values,
      resolvedThemeMode: state.resolvedThemeMode,
      setPreference: state.setPreference,
      resetPreferences: state.resetPreferences,
    })),
  );

  const {
    theme_mode: themeMode,
    theme_preset: themePreset,
    content_layout: contentLayout,
    navbar_style: navbarStyle,
    sidebar_variant: variant,
    sidebar_collapsible: collapsible,
    font,
  } = values;

  const onThemePresetChange = (value: string) => {
    const preset = PREFERENCE_REGISTRY.theme_preset.values.find((preset) => preset === value);
    if (!preset) return;
    setPreference("theme_preset", preset);
  };

  const onThemeModeChange = (value: string) => {
    const mode = PREFERENCE_REGISTRY.theme_mode.values.find((mode) => mode === value);
    if (!mode) return;
    setPreference("theme_mode", mode);
  };

  const onContentLayoutChange = (value: string) => {
    const layout = PREFERENCE_REGISTRY.content_layout.values.find((layout) => layout === value);
    if (!layout) return;
    setPreference("content_layout", layout);
  };

  const onNavbarStyleChange = (value: string) => {
    const style = PREFERENCE_REGISTRY.navbar_style.values.find((style) => style === value);
    if (!style) return;
    setPreference("navbar_style", style);
  };

  const onSidebarStyleChange = (value: string) => {
    const variant = PREFERENCE_REGISTRY.sidebar_variant.values.find((variant) => variant === value);
    if (!variant) return;
    setPreference("sidebar_variant", variant);
  };

  const onSidebarCollapseModeChange = (value: string) => {
    const collapsible = PREFERENCE_REGISTRY.sidebar_collapsible.values.find((collapsible) => collapsible === value);
    if (!collapsible) return;
    setPreference("sidebar_collapsible", collapsible);
  };

  const onFontChange = (value: string) => {
    const font = PREFERENCE_REGISTRY.font.values.find((font) => font === value);
    if (!font) return;
    setPreference("font", font);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon">
          <Settings />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <div className="flex flex-col gap-5">
          <div className="space-y-1.5">
            <h4 className="text-sm leading-none font-medium">界面偏好</h4>
            <p className="text-muted-foreground text-xs">调整控制台的布局、主题与字体。</p>
          </div>
          <div className="space-y-3 **:data-[slot=toggle-group]:w-full **:data-[slot=toggle-group-item]:flex-1 **:data-[slot=toggle-group-item]:text-xs">
            <div className="space-y-1">
              <Label className="text-xs font-medium">主题配色</Label>
              <Select value={themePreset} onValueChange={onThemePresetChange}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue placeholder="配色" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {THEME_PRESET_OPTIONS.map((preset) => (
                      <SelectItem key={preset.value} className="text-xs" value={preset.value}>
                        <span
                          className="size-2.5 rounded-full"
                          style={{
                            backgroundColor: resolvedThemeMode === "dark" ? preset.primary.dark : preset.primary.light,
                          }}
                        />
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">字体</Label>
              <Select value={font} onValueChange={onFontChange}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue placeholder="选择字体" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {fontOptions.map((font) => (
                      <SelectItem key={font.key} className="text-xs" value={font.key}>
                        {font.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">明暗模式</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={themeMode}
                onValueChange={onThemeModeChange}
              >
                <ToggleGroupItem value="light" aria-label="切换为浅色">
                  浅色
                </ToggleGroupItem>
                <ToggleGroupItem value="dark" aria-label="切换为深色">
                  深色
                </ToggleGroupItem>
                <ToggleGroupItem value="system" aria-label="切换为跟随系统">
                  跟随系统
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">内容宽度</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={contentLayout}
                onValueChange={onContentLayoutChange}
              >
                <ToggleGroupItem value="centered" aria-label="切换为居中">
                  居中
                </ToggleGroupItem>
                <ToggleGroupItem value="full-width" aria-label="切换为通栏">
                  通栏
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">顶栏行为</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={navbarStyle}
                onValueChange={onNavbarStyleChange}
              >
                <ToggleGroupItem value="sticky" aria-label="切换为吸顶">
                  吸顶
                </ToggleGroupItem>
                <ToggleGroupItem value="scroll" aria-label="切换为随页滚动">
                  随页滚动
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">侧栏样式</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={variant}
                onValueChange={onSidebarStyleChange}
              >
                <ToggleGroupItem value="inset" aria-label="切换为嵌入">
                  嵌入
                </ToggleGroupItem>
                <ToggleGroupItem value="sidebar" aria-label="切换为标准侧栏">
                  标准
                </ToggleGroupItem>
                <ToggleGroupItem value="floating" aria-label="切换为浮动侧栏">
                  浮动
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-medium">侧栏收起方式</Label>
              <ToggleGroup
                size="sm"
                spacing={0}
                variant="outline"
                type="single"
                value={collapsible}
                onValueChange={onSidebarCollapseModeChange}
              >
                <ToggleGroupItem value="icon" aria-label="切换为图标收起">
                  图标
                </ToggleGroupItem>
                <ToggleGroupItem value="offcanvas" aria-label="切换为抽屉收起">
                  抽屉
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            <Button type="button" size="sm" variant="outline" className="w-full text-xs" onClick={resetPreferences}>
              恢复默认
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
