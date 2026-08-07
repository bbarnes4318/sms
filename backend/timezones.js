/**
 * Recipient local time, inferred from area code.
 *
 * Used only to keep sends inside the recipient's daytime window. Area codes map
 * to states, and several states straddle a timezone boundary, so this inference
 * can be off by one hour for a minority of numbers. The pacing layer compensates
 * by defaulting to a window narrower than the legal one (see pacing.js): a
 * one-hour error still lands inside 8am-9pm local, which is the TCPA limit.
 *
 * DST is handled by Intl, not by fixed offsets.
 */
const AreaCodes = require('./public/lib/area_codes');

const STATE_TZ = {
  AL: 'America/Chicago',    AK: 'America/Anchorage',  AZ: 'America/Phoenix',
  AR: 'America/Chicago',    CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York',   DE: 'America/New_York',   DC: 'America/New_York',
  FL: 'America/New_York',   GA: 'America/New_York',   HI: 'Pacific/Honolulu',
  ID: 'America/Boise',      IL: 'America/Chicago',    IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',    KS: 'America/Chicago',    KY: 'America/New_York',
  LA: 'America/Chicago',    ME: 'America/New_York',   MD: 'America/New_York',
  MA: 'America/New_York',   MI: 'America/Detroit',    MN: 'America/Chicago',
  MS: 'America/Chicago',    MO: 'America/Chicago',    MT: 'America/Denver',
  NE: 'America/Chicago',    NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York',   NM: 'America/Denver',     NY: 'America/New_York',
  NC: 'America/New_York',   ND: 'America/Chicago',    OH: 'America/New_York',
  OK: 'America/Chicago',    OR: 'America/Los_Angeles', PA: 'America/New_York',
  RI: 'America/New_York',   SC: 'America/New_York',   SD: 'America/Chicago',
  TN: 'America/Chicago',    TX: 'America/Chicago',    UT: 'America/Denver',
  VT: 'America/New_York',   VA: 'America/New_York',   WA: 'America/Los_Angeles',
  WI: 'America/Chicago',    WV: 'America/New_York',   WY: 'America/Denver',
  PR: 'America/Puerto_Rico', VI: 'America/St_Thomas', GU: 'Pacific/Guam'
};

// Area codes whose zone differs from their state's dominant zone. Only the
// unambiguous, single-zone cases are listed; codes that themselves straddle a
// boundary are left to the state default.
const AREA_CODE_TZ = {
  // Florida panhandle - Central, not Eastern
  '850': 'America/Chicago',
  // West Texas - Mountain
  '915': 'America/Denver',
  // Eastern Tennessee - Eastern, not Central
  '423': 'America/New_York', '865': 'America/New_York',
  // Western Kentucky - Central
  '270': 'America/Chicago', '364': 'America/Chicago',
  // Upper peninsula Michigan - Central
  '906': 'America/Chicago',
  // Southwest Kansas / western Nebraska - Mountain
  '308': 'America/Denver',
  // Northwest Indiana (Chicago metro) - Central
  '219': 'America/Chicago',
  // Southwest Indiana (Evansville) - Central
  '812': 'America/Chicago',
  // Western North Dakota - Mountain
  '701': 'America/Chicago',
  // Idaho panhandle - Pacific
  '986': 'America/Boise',
  // Seed/test range
  '555': 'America/New_York'
};

const hourFormatters = new Map();

function hourFormatter(tz) {
  let fmt = hourFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short'
    });
    hourFormatters.set(tz, fmt);
  }
  return fmt;
}

function areaCodeOf(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return national.length >= 10 ? national.slice(0, 3) : null;
}

/**
 * IANA timezone for a phone number, or null when it cannot be inferred.
 */
function timezoneFor(phoneNumber) {
  const area = areaCodeOf(phoneNumber);
  if (!area) return null;
  if (AREA_CODE_TZ[area]) return AREA_CODE_TZ[area];
  const state = AreaCodes.AREA_CODE_MAP[area] || null;
  return (state && STATE_TZ[state]) || null;
}

/**
 * Local hour (0-23) and weekday for a phone number at a given instant.
 * Returns null when the timezone cannot be inferred.
 */
function localTimeFor(phoneNumber, at) {
  const tz = timezoneFor(phoneNumber);
  if (!tz) return null;
  const parts = hourFormatter(tz).formatToParts(at || new Date());
  const hourPart = parts.find(p => p.type === 'hour');
  const dayPart = parts.find(p => p.type === 'weekday');
  if (!hourPart) return null;
  // en-US hour12:false renders midnight as "24" in some ICU builds.
  const hour = Number(hourPart.value) % 24;
  return { timezone: tz, hour, weekday: dayPart ? dayPart.value : null };
}

module.exports = { timezoneFor, localTimeFor, areaCodeOf, STATE_TZ, AREA_CODE_TZ };
