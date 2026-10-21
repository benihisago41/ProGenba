import React, { createContext, useContext, useState } from "react";
import {
  FluentProvider, webLightTheme, webDarkTheme, makeStyles, tokens,
  Button, MessageBar, MessageBarBody, Dialog, DialogSurface, DialogBody,
  DialogTitle, DialogContent, DialogActions,
} from "@fluentui/react-components";
import { WeatherMoon20Regular, WeatherSunny20Regular } from "@fluentui/react-icons";

const ThemeContext = createContext({ dark: false, toggle: () => {} });
const useProviderStyles = makeStyles({ root: { minHeight: "100vh", backgroundColor: tokens.colorNeutralBackground2, '& .fui-Button': { minHeight: "44px" }, '& .fui-Tab': { minHeight: "44px" }, '& .fui-AccordionHeader__button': { minHeight: "44px" } } });

export function Providers({ children }: { children: React.ReactNode }) {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem("progenba-theme") === "dark"; } catch { return false; }
  });
  const styles = useProviderStyles();
  const toggle = () => setDark(value => {
    try { localStorage.setItem("progenba-theme", value ? "light" : "dark"); } catch { /* 設定の保存が禁止された端末でも切り替えは可能 */ }
    return !value;
  });
  return <ThemeContext.Provider value={{ dark, toggle }}><FluentProvider theme={dark ? webDarkTheme : webLightTheme} className={styles.root} style={{ colorScheme: dark ? "dark" : "light" }}>{children}</FluentProvider></ThemeContext.Provider>;
}

export function ThemeButton() {
  const { dark, toggle } = useContext(ThemeContext);
  return <Button appearance="subtle" size="large" icon={dark ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />} onClick={toggle} aria-label={dark ? "ライト表示に切り替え" : "ダーク表示に切り替え"} title={dark ? "ライト表示" : "ダーク表示"} />;
}

export function Notice({ intent = "info", children }: { intent?: "info" | "success" | "warning" | "error"; children: React.ReactNode }) {
  return <MessageBar intent={intent}><MessageBarBody>{children}</MessageBarBody></MessageBar>;
}

export function ConfirmDialog({ open, title, children, action, onConfirm, onCancel }: {
  open: boolean; title: string; children: React.ReactNode; action: string; onConfirm: () => void; onCancel: () => void;
}) {
  return <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onCancel(); }}>
    <DialogSurface><DialogBody><DialogTitle>{title}</DialogTitle><DialogContent>{children}</DialogContent><DialogActions>
      <Button appearance="secondary" size="large" onClick={onCancel} autoFocus>戻る</Button>
      <Button appearance="primary" size="large" onClick={onConfirm}>{action}</Button>
    </DialogActions></DialogBody></DialogSurface>
  </Dialog>;
}

export const usePageStyles = makeStyles({
  stack: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalXXL, minWidth: 0 },
  compact: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalM, minWidth: 0 },
  row: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: tokens.spacingHorizontalM },
  spread: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: tokens.spacingHorizontalL },
  card: { paddingTop: tokens.spacingVerticalXXL, paddingBottom: tokens.spacingVerticalXXL, paddingLeft: tokens.spacingHorizontalXXL, paddingRight: tokens.spacingHorizontalXXL, minWidth: 0, boxShadow: tokens.shadow2, borderRadius: tokens.borderRadiusXLarge },
  muted: { color: tokens.colorNeutralForeground3 },
  brand: { color: tokens.colorBrandForeground1 },
  danger: { color: tokens.colorStatusDangerForeground1 },
  fields: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: tokens.spacingHorizontalXL, '@media (max-width: 640px)': { gridTemplateColumns: "minmax(0, 1fr)" } },
  full: { gridColumn: "1 / -1", minWidth: 0 },
  control: { minHeight: "44px", minWidth: 0, width: "100%" },
  scroll: { overflowX: "auto", minWidth: 0, maxWidth: "100%" },
  number: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", textAlign: "right" },
  inset: { backgroundColor: tokens.colorNeutralBackground2, borderRadius: tokens.borderRadiusLarge, paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL, paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL },
});
