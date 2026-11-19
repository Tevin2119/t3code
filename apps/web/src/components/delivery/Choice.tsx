import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** A delivery form's single-choice select, named by `label` for assistive technology. */
export function Choice({
  label,
  value,
  items,
  placeholder = label,
  onChange,
}: {
  label: string;
  value: string;
  items: readonly { value: string; label: string }[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      items={items}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
