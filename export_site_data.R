# Export the combined QCEW files (from pull_qcew_state_industry.R) into small
# per-state files for the Reposit-ORVI static site (GitHub Pages serves docs/).
#
# Output (under docs/data/):
#   manifest.json          states, year ranges, ownership / level / industry lookups
#   <series>/<fips>.csv.gz one compact file per state (codes only, no title text)

library(data.table)
library(jsonlite)

freq     <- "annual"
in_dir   <- "data/qcew"
site_dir <- "docs/data"

# Compact column names used by the site
col_map <- c(year = "year", own = "own_code", lvl = "agglvl_code", ind = "industry_code",
             disc = "disclosure_code", estabs = "annual_avg_estabs_count",
             emp = "annual_avg_emplvl", wages = "total_annual_wages",
             tax_wages = "taxable_annual_wages", contrib = "annual_contributions",
             wkly_wage = "annual_avg_wkly_wage", avg_pay = "avg_annual_pay")

series_meta <- list(
  naics = list(label = "NAICS (1990 onward)", note = "North American Industry Classification System"),
  sic   = list(label = "SIC (1975-2000)",     note = "Standard Industrial Classification")
)

manifest <- list(generated = format(Sys.Date()), source = "BLS Quarterly Census of Employment and Wages",
                 columns = names(col_map), series = list())

for (s in names(series_meta)) {
  d <- readRDS(file.path(in_dir, sprintf("qcew_state_industry_%s_%s.rds", s, freq)))
  out <- file.path(site_dir, s)
  dir.create(out, recursive = TRUE, showWarnings = FALSE)

  # Lookups: industry titles vary slightly by year (some carry a code prefix),
  # so strip the prefix and keep the most recent title for each code.
  # Retired codes carry a version prefix ("1972 SIC 121 ...", "NAICS12 4521 ..."); flag those.
  d[, title_clean := trimws(sub("^(19[0-9]{2}\\s+)?(NAICS[0-9]{2}|NAICS|SIC)?\\s*[0-9A-Z]*[0-9][0-9A-Z]*(-[0-9]+)?\\s+(?=[A-Za-z])", "",
                                industry_title, perl = TRUE))]
  d[grepl("^1972 SIC", industry_title), title_clean := paste(title_clean, "(1972 SIC)")]
  d[grepl("^NAICS[0-9]{2} ", industry_title),
    title_clean := paste0(title_clean, " (NAICS 20", substr(industry_title, 6, 7), " code)")]
  ind <- d[order(-year), .(title = title_clean[1], lvl = agglvl_code[1]), by = industry_code]
  setorder(ind, lvl, industry_code)
  lvls  <- unique(d[, .(code = agglvl_code, title = sub("^State,\\s*", "", agglvl_title))])[order(code)]
  owns  <- unique(d[, .(code = own_code, title = own_title)])[order(code)]
  # one name per FIPS (DC's title varies across years); use the most common one
  areas <- d[, .N, by = .(fips = area_fips, name = sub(" -- Statewide$", "", area_title))
             ][order(-N), .SD[1], by = fips][order(name), .(fips, name)]

  cols <- unname(col_map)
  for (f in areas$fips) {
    x <- d[area_fips == f, ..cols]
    setnames(x, names(col_map))
    setorder(x, year, lvl, ind, own)
    fwrite(x, file.path(out, paste0(f, ".csv.gz")))
  }

  manifest$series[[s]] <- list(
    label = series_meta[[s]]$label, note = series_meta[[s]]$note,
    years = range(d$year), states = areas, levels = lvls, ownership = owns,
    industries = ind[, .(code = industry_code, title, lvl)]
  )
  message(sprintf("%s: %d state files written", s, nrow(areas)))
}

write_json(manifest, file.path(site_dir, "manifest.json"), auto_unbox = TRUE, dataframe = "rows")
