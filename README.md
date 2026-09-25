# Reposit-ORVI

Ohio River Valley Institute data repository. The site in `docs/` lets anyone filter BLS Quarterly Census of Employment and Wages (QCEW) data by state, year, industry and ownership, and download the subset as a CSV. Filtering runs entirely in the browser; the data is stored as one compressed file per state.

- **NAICS series:** 1990 to the latest annual release, state totals down to 6-digit industries
- **SIC series:** 1975–2000, state totals down to 4-digit industries

## Updating the data

```r
source("pull_qcew_state_industry.R")  # downloads new BLS annual files into data/qcew (not committed)
source("export_site_data.R")          # rebuilds docs/data/ for the site
```

Then commit and push `docs/data/`. BLS publishes each year's annual averages around September of the following year.

## Previewing locally

```bash
python3 -m http.server 8765 --directory docs
```

Source: U.S. Bureau of Labor Statistics, [QCEW](https://www.bls.gov/cew/).
