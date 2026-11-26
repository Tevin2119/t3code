import { Input } from "../ui/input";

export function ApprovalKeyInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Input
      aria-label="Approval passphrase or terminal key"
      placeholder="Approval passphrase or terminal key"
      name="delivery-approval"
      type="password"
      autoComplete="current-password"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}
