/**
 * Content risk linter for outbound SMS.
 *
 * Carriers filter A2P traffic on content as well as volume. This scores a
 * message template BEFORE thousands of copies are queued, so a bad template is
 * caught at compose time instead of after the campaign burns a DID's reputation.
 *
 * Nothing here blocks a send. It returns findings; the caller decides.
 *
 * Pure module: no database, no I/O. Shared by the server and the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ContentLint = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const SEVERITY = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

  // Public URL shorteners. Carriers treat these as the single strongest content
  // signal for spam, because they hide the destination from filtering.
  const SHORTENER_HOSTS = [
    'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
    'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'bit.do',
    'shorte.st', 'adf.ly', 'lnkd.in', 'trib.al', 'clck.ru', 'soo.gd', 'qr.ae'
  ];

  // Phrases that score heavily in carrier spam models. Grouped so the finding
  // can explain the category rather than just naming the word.
  const TRIGGER_PHRASES = [
    { re: /\bfree\b/i, label: 'free', category: 'offer' },
    { re: /\b100%\s*free\b/i, label: '100% free', category: 'offer' },
    { re: /\bno\s+(cost|obligation|catch|fee[s]?)\b/i, label: 'no cost/obligation', category: 'offer' },
    { re: /\brisk[-\s]?free\b/i, label: 'risk-free', category: 'offer' },
    { re: /\bguarantee(d|s)?\b/i, label: 'guaranteed', category: 'claim' },
    { re: /\bpre[-\s]?approved\b/i, label: 'pre-approved', category: 'claim' },
    { re: /\byou (have been|are) selected\b/i, label: 'you are selected', category: 'claim' },
    { re: /\bcongratulations\b/i, label: 'congratulations', category: 'claim' },
    { re: /\bwinner\b/i, label: 'winner', category: 'claim' },
    { re: /\bact now\b/i, label: 'act now', category: 'urgency' },
    { re: /\blimited time\b/i, label: 'limited time', category: 'urgency' },
    { re: /\bexpires? (today|soon|tonight)\b/i, label: 'expires today/soon', category: 'urgency' },
    { re: /\bdon'?t (miss|wait)\b/i, label: "don't miss/wait", category: 'urgency' },
    { re: /\burgent\b/i, label: 'urgent', category: 'urgency' },
    { re: /\bclick (here|below|now)\b/i, label: 'click here', category: 'cta' },
    { re: /\bcall now\b/i, label: 'call now', category: 'cta' },
    { re: /\bcash\b/i, label: 'cash', category: 'money' },
    { re: /\$\$+/, label: '$$', category: 'money' },
    { re: /\bcredit (score|repair)\b/i, label: 'credit score/repair', category: 'money' },
    { re: /\blowest (rate|price)s?\b/i, label: 'lowest rates', category: 'money' },
    { re: /\bsave up to\b/i, label: 'save up to', category: 'money' }
  ];

  // Opt-out language a compliant first-touch message should carry.
  const OPT_OUT_RE = /\b(reply|text)\s+stop\b|\bstop\s*(2|to)\s*(end|opt.?out|unsubscribe|cancel)\b|\bopt\s*out\b|\bunsubscribe\b/i;

  // Characters outside GSM-7 force the whole message into UCS-2, which cuts the
  // per-segment budget from 160 chars to 70. Smart quotes pasted from Word are
  // the usual culprit and are invisible to the person writing the template.
  const GSM7 =
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  const GSM7_EXT = '^{}\\[~]|€';

  function isGsm7(text) {
    for (const ch of text) {
      if (GSM7.indexOf(ch) === -1 && GSM7_EXT.indexOf(ch) === -1) return false;
    }
    return true;
  }

  /**
   * Segment count and encoding. Multi-segment messages cost more and are more
   * likely to be truncated or reassembled out of order by the handset.
   */
  function measure(text) {
    const body = text || '';
    const gsm = isGsm7(body);
    let units = 0;
    if (gsm) {
      for (const ch of body) units += GSM7_EXT.indexOf(ch) !== -1 ? 2 : 1;
    } else {
      // UCS-2 counts code units, so astral characters (most emoji) count as 2.
      units = body.length;
    }
    const single = gsm ? 160 : 70;
    const multi = gsm ? 153 : 67;
    const segments = units === 0 ? 0 : (units <= single ? 1 : Math.ceil(units / multi));
    return { encoding: gsm ? 'GSM-7' : 'UCS-2', units, segments };
  }

  function findUrls(text) {
    const re = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?/gi;
    const urls = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      urls.push({ raw: m[0], host: m[1].toLowerCase() });
    }
    return urls;
  }

  function capsRatio(text) {
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length < 12) return 0;
    const upper = letters.replace(/[^A-Z]/g, '').length;
    return upper / letters.length;
  }

  function countEmoji(text) {
    const re = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F900}-\u{1F9FF}]/gu;
    return (text.match(re) || []).length;
  }

  /**
   * Lint a message template.
   *
   * @param {string} text        The template, placeholders included.
   * @param {object} options
   *   options.requireOptOut   Treat a missing STOP disclosure as a finding.
   *                           True for first-touch/bulk, false for one-to-one.
   *   options.brandTerms      Strings that count as identifying the sender.
   * @returns {{score:number, level:string, findings:Array, measure:object}}
   */
  function lint(text, options) {
    const opts = options || {};
    const body = String(text == null ? '' : text);
    const findings = [];
    const add = (severity, code, message, hint) =>
      findings.push({ severity, code, message, hint });

    const stats = measure(body);

    if (!body.trim()) {
      return { score: 0, level: 'ok', findings, measure: stats };
    }

    // --- Links -------------------------------------------------------------
    const urls = findUrls(body);
    for (const url of urls) {
      if (SHORTENER_HOSTS.includes(url.host)) {
        add(SEVERITY.HIGH, 'url_shortener',
          `Public URL shortener "${url.host}" — the strongest single spam signal carriers look for.`,
          'Use a branded/dedicated short domain or the full destination URL.');
      }
    }
    if (urls.length > 1) {
      add(SEVERITY.MEDIUM, 'multiple_urls',
        `${urls.length} links in one message.`,
        'One link per message. Multiple links reads as bulk marketing.');
    }

    // --- Trigger phrases ---------------------------------------------------
    const hits = TRIGGER_PHRASES.filter(t => t.re.test(body));
    for (const hit of hits) {
      add(hit.category === 'claim' ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        `phrase_${hit.category}`,
        `Contains "${hit.label}" (${hit.category} language).`,
        'Rephrase plainly. Insurance claim language also carries regulatory risk.');
    }
    if (hits.length >= 3) {
      add(SEVERITY.HIGH, 'phrase_density',
        `${hits.length} separate spam-trigger phrases in one message.`,
        'Any one of these is survivable; stacked together they reliably filter.');
    }

    // --- Formatting --------------------------------------------------------
    const caps = capsRatio(body);
    if (caps > 0.5) {
      add(SEVERITY.HIGH, 'shouting',
        `${Math.round(caps * 100)}% of letters are uppercase.`,
        'Write in sentence case.');
    } else if (caps > 0.3) {
      add(SEVERITY.MEDIUM, 'caps_heavy',
        `${Math.round(caps * 100)}% of letters are uppercase.`,
        'Reserve caps for proper nouns.');
    }

    if (/[!?]{2,}/.test(body)) {
      add(SEVERITY.MEDIUM, 'punctuation',
        'Repeated exclamation or question marks.',
        'One mark is enough.');
    }

    const emoji = countEmoji(body);
    if (emoji > 2) {
      add(SEVERITY.MEDIUM, 'emoji_heavy',
        `${emoji} emoji.`,
        'Emoji also force UCS-2 encoding, cutting the segment budget to 70 characters.');
    }

    // --- Encoding and length ----------------------------------------------
    if (stats.encoding === 'UCS-2') {
      const smartQuotes = /[‘’“”–—…]/.test(body);
      add(smartQuotes ? SEVERITY.MEDIUM : SEVERITY.LOW, 'ucs2',
        `Non-GSM characters force UCS-2 encoding (70 chars per segment instead of 160).` +
        (smartQuotes ? ' Smart quotes/dashes are present — likely pasted from a word processor.' : ''),
        smartQuotes ? "Replace curly quotes with ' and \" and em dashes with -." : undefined);
    }
    if (stats.segments > 2) {
      add(SEVERITY.MEDIUM, 'segments',
        `${stats.segments} segments (${stats.units} characters).`,
        'Long messages cost more per send and are more likely to be filtered.');
    }

    // --- Compliance --------------------------------------------------------
    if (opts.requireOptOut && !OPT_OUT_RE.test(body)) {
      add(SEVERITY.HIGH, 'missing_opt_out',
        'No opt-out language.',
        'Add "Reply STOP to opt out." A missing disclosure drives complaint rates, ' +
        'which is what actually gets a number blocked.');
    }

    const brandTerms = (opts.brandTerms || []).filter(Boolean);
    if (brandTerms.length && !brandTerms.some(t => body.toLowerCase().includes(String(t).toLowerCase()))) {
      add(SEVERITY.MEDIUM, 'missing_brand',
        'Message does not identify the sender.',
        'Unidentified first-touch messages get reported as spam far more often.');
    }

    const weight = { high: 25, medium: 10, low: 3 };
    const score = Math.min(100, findings.reduce((sum, f) => sum + weight[f.severity], 0));
    const level = score >= 50 ? 'high' : score >= 20 ? 'medium' : score > 0 ? 'low' : 'ok';

    return { score, level, findings, measure: stats };
  }

  return { lint, measure, isGsm7, SEVERITY, OPT_OUT_RE, SHORTENER_HOSTS };
}));
