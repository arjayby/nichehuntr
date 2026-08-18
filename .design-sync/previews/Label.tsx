import { Label, Input, Checkbox } from "@nichehuntr/ui";

export function WithInput() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 320 }}>
      <Label htmlFor="name">Full name</Label>
      <Input id="name" placeholder="Ada Lovelace" />
    </div>
  );
}

export function WithCheckbox() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Checkbox id="remember" defaultChecked />
      <Label htmlFor="remember">Remember me on this device</Label>
    </div>
  );
}
