'use client';

import { useRef, useState } from 'react';

// The formula box with the variables at hand: as the ceramist types a name, the ones that match
// appear under the field and a click writes it in. The list holds the HMI's own variables and
// the ones the platform works out for the shift (pieces, hours producing, pace).

export interface VariableOption {
  name: string;
  /** What it is, in the plant's words. */
  description: string;
  /** Its value right now, already formatted, so the choice is obvious. */
  value: string;
}

export function FormulaInput({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: VariableOption[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('');

  /** The name being typed: from the last character that cannot be part of a name to the caret. */
  function wordAt(text: string, caret: number) {
    const before = text.slice(0, caret);
    const match = before.match(/[A-Za-z_][A-Za-z0-9_.]*$/);
    return match ? match[0] : '';
  }

  const matches = (() => {
    const term = word.trim().toLowerCase();
    const list = term
      ? options.filter((option) => option.name.toLowerCase().includes(term))
      : options;
    return list.slice(0, 8);
  })();

  function insert(name: string) {
    const field = input.current;
    const caret = field?.selectionStart ?? value.length;
    const typed = wordAt(value, caret);
    const next = value.slice(0, caret - typed.length) + name + value.slice(caret);
    onChange(next);
    setOpen(false);
    setWord('');
    requestAnimationFrame(() => {
      field?.focus();
      const at = caret - typed.length + name.length;
      field?.setSelectionRange(at, at);
    });
  }

  return (
    <div className="formula-field">
      <input
        ref={input}
        className="formula-input"
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
          setWord(wordAt(event.target.value, event.target.selectionStart ?? 0));
          setOpen(true);
        }}
        onFocus={(event) => {
          setWord(wordAt(event.target.value, event.target.selectionStart ?? 0));
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'Tab' && open && matches.length) {
            event.preventDefault();
            insert(matches[0].name);
          }
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && matches.length > 0 && (
        <ul className="formula-suggestions">
          {matches.map((option) => (
            <li key={option.name}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insert(option.name)}>
                <code>{option.name}</code>
                <span>{option.description}</span>
                <b>{option.value}</b>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
