# Schema Doc Update — April 2026 Wave

This is the patch to apply to `docs/schema_doc.md` after the April load completes (after Phase 6, before Phase 7 closes out).

## What to add

In the section that describes question categories or topical coverage, add:

### Banking battery (Q416-428, ~84 items)

The April 2026 wave introduced a comprehensive banking measurement layer. Available constructs:

- **Q416** Current banking situation (single primary bank, multi-bank, neobank)
- **Q417** Institution types currently used (national bank, credit union, neobank, brokerage, etc.) — multi-select with named brand examples
- **Q418** Length of relationship with primary institution
- **Q419** Triggers for opening new accounts (multi-select, 11 reasons)
- **Q420** Joy drivers when discovering a bank you feel good about (joy_scale_0_to_5, 10 items)
- **Q421** Importance of features when choosing a new bank (importance_scale_0_to_5, 11 items)
- **Q422** Quality of current bank relationship (description_scale_0_to_5, 10 items)
- **Q423** Switching behavior in past 3 years (single_select)
- **Q424** Reasons for switching (multi-select, 11 items)
- **Q425** What keeps them with current bank (multi-select with open-end)
- **Q426** Joy modes the current bank delivers (multi-select on 8 joy modes)
- **Q427** General relationship with money/financial system (description_scale_0_to_5, 8 items)
- **Q428** Open-end: what would the bank do differently if it understood my financial life

This battery covers the financial services brand intelligence gap that was thin in prior waves. Investigators pursuing financial services brands should query items linked to questions 416-428 directly. Banking joy scoring is now structurally available alongside the broader financial_services items already in the data.

### Wine battery (Q429-444, ~106 items)

The April 2026 wave introduced full category-level emotional measurement for wine, modeled on the coffee question pattern that produced strong investigative outputs in prior sessions.

- **Q429** Current relationship with wine (single_select screener — frequency/affinity)
- **Q430** Drinking occasions (multi-select, 11 items)
- **Q431** Wine drinking direction (more/less/same)
- **Q432** Reasons for drinking less (multi-select, 10 items)
- **Q433** Joy drivers when drinking wine (joy_scale_0_to_5, 12 items including taste, discovery, sharing, ritual)
- **Q434** Joy modes wine triggers (multi-select on 10 joy modes — playful, aesthetic, hedonic, etc.)
- **Q435** Comparative joy across beverages (joy_scale_0_to_5, 10 items: wine, craft beer, cocktails, etc.) — useful for competitive set redefinition queries
- **Q436** Importance of drink attributes (importance_scale_0_to_5, 10 items: provenance, story, sustainability, taste)
- **Q437** Reasons for not drinking wine (multi-select, 14 items)
- **Q438** Open-end: what would make you more interested in wine
- **Q439** Wine category perceptions (description_scale_0_to_5, 9 items: gatekeeping, accessibility, evolution)
- **Q440** Open-end: most memorable wine experience
- **Q441** Wine identity fit (multi-select, 7 items)
- **Q442** Wine category direction perceptions (multi-select, 7 items)
- **Q443** Bottle price ranges purchased at stores
- **Q444** Glass price ranges at bars/restaurants

For wine pursuits, the investigator should query items linked to Q429-444 directly. **Q429 functions as a wine consumption screener** and can be used to filter respondent populations to wine drinkers (similar to how alcohol consumption screeners work elsewhere in the data).

### Cross-category (Q445-446)

- **Q445** Single-select on attitude toward "traditional/established categories" (banking and wine as exemplars). Useful for segmenting respondents by their general posture toward legacy categories vs. emerging ones.

- **Q446** Multi-select on which joy modes the respondent most wants from category choices generally (10-item joy-mode preference). **This question is strategically valuable**: it lets investigators answer "what JOY MODE does this audience prioritize" using direct survey data instead of inferring from text. Prior sessions inferred audience joy mode preferences from verbatim corpus tags; Q446 provides a clean explicit measure.

## Updates elsewhere in schema_doc.md

Find any text that says:

- "Data ends 2026-03" or similar → update to "Data ends 2026-04 (April 2026 wave loaded XXX 2026)"
- "12,663 respondents" → update to "13,064 respondents"
- "415 questions" → update to "446 questions"
- "5,391 items" → update to whatever the post-load max_item_id is
- "62,755 verbatims" → update to whatever the post-load count is

## Note on screener taxonomy

If Phase 6 runs (loading wine consumption from Q429 into bjl_respondent_usage), add a 'wine' category to the bjl_respondent_usage screener taxonomy section. Otherwise leave that section unchanged and surface as a follow-up question.
