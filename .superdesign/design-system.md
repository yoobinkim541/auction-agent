# Gyeongmae Agent Design System

## Product Context

Personal real-estate auction analysis dashboard for fast bid/no-bid decisions. The UI must reduce cognitive load for high-risk auction review: rights risk, hidden tenant deposits, safe bid, actual margin, sale deadlines, fieldwork checklist, and post-auction learning signals.

## Visual Direction

- Keep a dark professional analytics base, but modernize from dense terminal-table toward an investment operations cockpit.
- Prioritize hierarchy: today actions and urgent D-Day risks first, then filters, then listing exploration.
- Use compact but breathable cards, sticky controls, clearer grouping, and stronger visual hierarchy.
- Keep Korean labels, financial numeric density, and mono figures for scanability.

## Tokens

- Background: #070b12, panels #0d1118 / #121822 / #18202e.
- Text: #dde7f8, muted #60718f, secondary #8fa0be.
- Accent: #4178ff.
- Success/clean: #1ec758. Warning: #f5a623. Risk/danger: #f04545. Review: #9b7cf7.
- Radius: 8-14px current, modernized direction can use 14-22px for cards and shell.
- Font: Pretendard/Noto Sans KR stack for text, IBM Plex Mono/ui-monospace for figures and case numbers.

## UX Principles

1. Decision-first: show "what needs action now" before tables.
2. Progressive disclosure: summary cockpit → list/table → detail drawer.
3. Safer scanning: risk, D-Day, hidden costs, and assumed amounts must be visually louder than generic metadata.
4. Dense data is okay, but controls should feel calm and grouped.
5. Mobile should feel like card triage, not a squeezed table.

## Component Patterns

- KPI card: label, mono number, optional trend/intent.
- Action card: severity rail, action type pill, title, case number, reason, due date.
- Filter bar: grouped controls with search dominant and secondary filters tucked into menu/chips.
- Listing row/card: address + case, risk chips, price/margin cluster, D-Day cluster, score.
- Detail drawer: sticky topbar, hero summary, source links, key-value grid, reports/checklists.

## Current CSS Source

See `.superdesign/init/theme.md` and `web/src/styles.css`.
