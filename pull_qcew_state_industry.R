# Pull QCEW (BLS Quarterly Census of Employment and Wages) state-by-industry
# data as far back as BLS publishes it.
#
#   SIC-based series   : 1975 - 2000  (agglvl 18-23: state total -> 4-digit SIC)
#   NAICS-based series : 1990 - latest (agglvl 50-58: state total -> 6-digit NAICS)
#
# The two series overlap in 1990-2000 but use different industry codes, so they
# are saved separately. Source: https://www.bls.gov/cew/downloadable-data-files.htm
#
# Output (under data/qcew/):
#   raw/                         cached BLS zip files (re-runs skip downloads)
#   processed/<series>_<year>.csv.gz  one filtered file per year
#   qcew_state_industry_naics_<freq>.rds / .csv.gz   combined NAICS
#   qcew_state_industry_sic_<freq>.rds   / .csv.gz   combined SIC

library(data.table)
library(httr)

# ---- Settings ---------------------------------------------------------------
freq       <- "annual"   # "annual" (annual averages) or "qtrly" (monthly employment by quarter; ~3x larger)
out_dir    <- "data/qcew"
keep_lq    <- FALSE      # keep location-quotient columns (lq_*)
keep_oty   <- FALSE      # keep over-the-year change columns (oty_*)
user_agent <- "ORVI research (nickvmessenger@gmail.com)"  # BLS rejects requests without a UA

naics_years <- 1990:as.integer(format(Sys.Date(), "%Y"))
sic_years   <- 1975:2000
state_agglvl <- list(naics = as.character(50:58), sic = as.character(18:23))

raw_dir  <- file.path(out_dir, "raw")
proc_dir <- file.path(out_dir, "processed")
dir.create(raw_dir,  recursive = TRUE, showWarnings = FALSE)
dir.create(proc_dir, recursive = TRUE, showWarnings = FALSE)
options(timeout = 3600)

# ---- Helpers ----------------------------------------------------------------
qcew_url <- function(year, series) {
  base <- "https://data.bls.gov/cew/data/files"
  if (series == "naics") sprintf("%s/%d/csv/%d_%s_by_industry.zip", base, year, year, freq)
  else                   sprintf("%s/%d/sic/csv/sic_%d_%s_by_industry.zip", base, year, year, freq)
}

download_year <- function(year, series) {
  dest <- file.path(raw_dir, basename(qcew_url(year, series)))
  if (file.exists(dest) && file.size(dest) > 0) return(dest)
  url <- qcew_url(year, series)
  resp <- GET(url, user_agent(user_agent), write_disk(dest, overwrite = TRUE), timeout(3600))
  if (status_code(resp) != 200) {
    unlink(dest)
    message(sprintf("  %s %d not available (HTTP %d)", series, year, status_code(resp)))
    return(NULL)
  }
  dest
}

id_cols <- c("area_fips", "own_code", "industry_code", "agglvl_code", "size_code",
             "year", "qtr", "disclosure_code", "area_title", "own_title",
             "industry_title", "agglvl_title", "size_title")

read_state_rows <- function(zip_path, series) {
  tmp <- tempfile("qcew_")
  on.exit(unlink(tmp, recursive = TRUE))
  unzip(zip_path, exdir = tmp)
  files <- list.files(tmp, pattern = "\\.csv$", recursive = TRUE, full.names = TRUE)

  dt <- rbindlist(lapply(files, function(f) {
    d <- fread(f, colClasses = "character", showProgress = FALSE)
    d[agglvl_code %in% state_agglvl[[series]]]
  }), use.names = TRUE, fill = TRUE)

  if (!keep_lq)  dt[, grep("^lq_",  names(dt), value = TRUE) := NULL]
  if (!keep_oty) dt[, grep("^oty_", names(dt), value = TRUE) := NULL]

  num_cols <- setdiff(names(dt), c(id_cols, grep("disclosure_code$", names(dt), value = TRUE)))
  dt[, (num_cols) := lapply(.SD, as.numeric), .SDcols = num_cols]
  dt[, year := as.integer(year)]
  dt[, industry_code := sub("^SIC_", "", industry_code)]
  dt[]
}

process_series <- function(series, years) {
  for (y in years) {
    out_file <- file.path(proc_dir, sprintf("%s_%s_%d.csv.gz", series, freq, y))
    if (file.exists(out_file)) { message(sprintf("%s %d: already processed", series, y)); next }
    message(sprintf("%s %d: downloading...", series, y))
    z <- download_year(y, series)
    if (is.null(z)) next
    dt <- read_state_rows(z, series)
    fwrite(dt, out_file)
    message(sprintf("%s %d: %s state rows", series, y, format(nrow(dt), big.mark = ",")))
  }

  files <- list.files(proc_dir, pattern = sprintf("^%s_%s_\\d{4}\\.csv\\.gz$", series, freq), full.names = TRUE)
  # read via gzip -dc so fread doesn't need the R.utils package
  all <- rbindlist(lapply(files, function(f) fread(cmd = paste("gzip -dc", shQuote(f)),
                                                   colClasses = list(character = id_cols))),
                   use.names = TRUE, fill = TRUE)
  all[, year := as.integer(year)]
  setorder(all, year, area_fips, own_code, agglvl_code, industry_code)
  saveRDS(all, file.path(out_dir, sprintf("qcew_state_industry_%s_%s.rds", series, freq)))
  fwrite(all,  file.path(out_dir, sprintf("qcew_state_industry_%s_%s.csv.gz", series, freq)))
  message(sprintf("%s combined: %s rows, years %d-%d", series,
                  format(nrow(all), big.mark = ","), min(all$year), max(all$year)))
  invisible(all)
}

# ---- Run --------------------------------------------------------------------
naics <- process_series("naics", naics_years)
sic   <- process_series("sic",   sic_years)
