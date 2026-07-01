import { Checkbox, Label } from "@nichehuntr/ui";

const item: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

export function WithLabels() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={item}>
        <Checkbox id="terms" defaultChecked />
        <Label htmlFor="terms">Accept terms and conditions</Label>
      </div>
      <div style={item}>
        <Checkbox id="news" />
        <Label htmlFor="news">Subscribe to the newsletter</Label>
      </div>
      <div style={item}>
        <Checkbox id="disabled" disabled />
        <Label htmlFor="disabled">Disabled option</Label>
      </div>
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
      <div style={item}>
        <Checkbox defaultChecked />
        <span style={{ fontSize: 13 }}>Checked</span>
      </div>
      <div style={item}>
        <Checkbox />
        <span style={{ fontSize: 13 }}>Unchecked</span>
      </div>
      <div style={item}>
        <Checkbox disabled defaultChecked />
        <span style={{ fontSize: 13 }}>Disabled</span>
      </div>
    </div>
  );
}
