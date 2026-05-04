# Demographic Column Map (from spreadsheet header positions)

The April 2026 spreadsheet columns are at these positions for the standard demographic fields. CC: verify these match your actual respondent insert script before running Phase 3.

| Column Index | Header                              | Maps to bjl_respondents column |
|--------------|-------------------------------------|--------------------------------|
| 0            | Response ID                         | external_response_id           |
| 2            | Date Submitted                      | year_month (extract YYYY-MM)   |
| 17           | State/Region                        | region                         |
| 20           | State                               | state                          |
| 55           | Age                                 | age (compute generation/age_band) |
| 56           | Children under 18 living with you   | parental_status (compute)      |
| 57           | Income                              | income_bracket                 |
| 58           | Employment status                   | employment_status              |
| 63           | Gender                              | gender                         |
| 67-72        | Race/ethnicity multi-select         | race_ethnicity (combine)       |
| 3678         | Children under 18 (duplicate)       | (use earlier col 56)           |
| 3679         | Marital status                      | marital_status                 |

## Generation calculation from Age column

Use the standard mapping that prior loads used:
- 18-26 → Gen Z
- 27-42 → Millennial
- 43-58 → Gen X
- 59-77 → Boomer
- 78+   → Silent

## Year-month extraction

Strip the date portion, convert to `YYYY-MM` text format. For April 2026 data, all rows should produce `2026-04`. Any deviation is a data quality issue worth surfacing.

## Income bracket normalization

The income column has free-text bracket values like "$100,000 to $124,999". Match these against the existing bjl_respondents.income_bracket distinct values to maintain consistency. If April introduces a new bracket, fail loudly rather than silently inserting a non-canonical value.

## Race/ethnicity composition

Multiple boolean columns (Asian, White, Black, Hispanic/Latino, etc.). Combine into a single text array or use the same encoding the prior loader used. Verify the existing bjl_respondents schema for race_ethnicity field type before inserting.

## Caveat

This map is derived from header text patterns, NOT from a confirmed prior loader script. CC should cross-check against whatever existing ingestion code exists in the repo (likely under `bin/` or `scripts/`) and against the actual bjl_respondents column list before running Phase 3.
