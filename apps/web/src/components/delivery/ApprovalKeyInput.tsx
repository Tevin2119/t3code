import { useGT } from "gt-react";
import { Input } from "../ui/input";

export function ApprovalKeyInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const gt = useGT();
  return (
    <Input
      aria-label={gt("Approval passphrase or terminal key")}
      placeholder={gt("Approval passphrase or terminal key")}
      name="delivery-approval"
      type="password"
      autoComplete="current-password"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}
