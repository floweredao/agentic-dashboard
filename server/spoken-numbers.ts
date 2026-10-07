/**
 * Korean readings of numbers with a unit, written out before text goes to TTS, so 5곳 is read 다섯 곳 rather than 오 곳.
 * The TTS model reads digits in 한자어, so a count with a native counter (곳, 명, 개, 시, 살, ...) is spelled in 고유어 up to 99
 * and in 한자어 above; 한자어 units (원, 년, 월, 일, 분, %, ...) are spelled in 한자어, with the
 * months 유월 and 시월. Digits without a known unit (phone numbers, versions, model names, bare years) are left as they are.
 */

const DIGITS = ["영", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const PLACES = ["", "십", "백", "천"];
const GROUPS = ["", "만", "억", "조", "경"];
const NATIVE_TENS = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"];
/** The forms a native number takes before a counter: 한 명, 두 개, 세 곳, 네 시. */
const NATIVE_ONES = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"];
const MONTHS = ["", "일월", "이월", "삼월", "사월", "오월", "유월", "칠월", "팔월", "구월", "시월", "십일월", "십이월"];
const BIG_WORDS: Record<string, number> = { 천: 1e3, 만: 1e4, 억: 1e8, 조: 1e12 };
const at = (list: readonly string[], index: number) => list[index] ?? "";

/** A whole number in 한자어: 10 십, 120 백이십, 2026 이천이십육, 29000 이만 구천, 10000 만, 1억 일억. */
export function sinoNumber(value: number): string {
  if (value === 0) return at(DIGITS, 0);
  const groups: string[] = [];
  for (let rest = value, index = 0; rest > 0; rest = Math.floor(rest / 10000), index += 1) {
    const group = rest % 10000;
    if (group === 0) continue;
    let text = "";
    for (let place = 3; place >= 0; place -= 1) {
      const digit = Math.floor(group / 10 ** place) % 10;
      if (digit !== 0) text += (digit === 1 && place > 0 ? "" : at(DIGITS, digit)) + at(PLACES, place);
    }
    groups.unshift(`${index === 1 && group === 1 ? "" : text}${at(GROUPS, index)}`);
  }
  return groups.join(" ");
}

/** A number from 1 to 99 in 고유어 as it stands before a counter (한, 두, 스무, 스물한); null outside that range. */
export function nativeNumber(value: number): string | null {
  if (!Number.isInteger(value) || value < 1 || value > 99) return null;
  const ones = value % 10;
  if (ones === 0) return value === 20 ? "스무" : at(NATIVE_TENS, value / 10);
  return at(NATIVE_TENS, Math.floor(value / 10)) + at(NATIVE_ONES, ones);
}

type Reading = "native" | "sino" | "hour" | "month" | "ordinal" | "dae";
/** Units after a number, how the number before them is read, and how a symbol unit is spoken. */
const UNITS = new Map<string, { reading: Reading; spoken: string }>();
for (const unit of ["곳", "개", "명", "사람", "마리", "권", "잔", "살", "번", "가지", "벌", "채", "척", "군데", "자리", "차례", "시간", "달", "배",
  "그루", "켤레", "송이", "통", "쌍", "끼"]) UNITS.set(unit, { reading: "native", spoken: unit });
for (const unit of ["개국", "개월", "개년", "개사", "개소", "개교", "년", "년대", "일", "분기", "분", "초", "층", "위", "회", "차", "세", "원", "주년", "주",
  "건", "배럴", "달러", "위안", "엔", "유로", "퍼센트", "퍼센트포인트", "도", "호", "부", "등", "점", "표", "석", "인분", "인", "킬로미터", "미터",
  "킬로그램", "톤"]) UNITS.set(unit, { reading: "sino", spoken: unit });
UNITS.set("시", { reading: "hour", spoken: "시" });
UNITS.set("월", { reading: "month", spoken: "월" });
UNITS.set("번째", { reading: "ordinal", spoken: "번째" });
UNITS.set("대", { reading: "dae", spoken: "대" });
for (const [unit, spoken] of [["%p", "퍼센트포인트"], ["%포인트", "퍼센트포인트"], ["%", "퍼센트"], ["％", "퍼센트"], ["km", "킬로미터"], ["kg", "킬로그램"],
  ["cm", "센티미터"], ["mm", "밀리미터"], ["GB", "기가바이트"], ["TB", "테라바이트"], ["MB", "메가바이트"], ["℃", "도"], ["°C", "도"]] as const) {
  UNITS.set(unit, { reading: "sino", spoken });
}
const UNIT_PATTERN = [...UNITS.keys()].sort((a, b) => b.length - a.length).map(unit => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
/** Digits with thousands commas and a decimal part, optionally with 천/만/억/조 and more digits: 1,500 / 4.2 / 2만9000 / 80조. */
const AMOUNT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[천만억조](?:(?:\d{1,3}(?:,\d{3})+|\d+)[천만억조]?)*)?`;
/** Not inside a longer token: a model name (G7, GPT-6), a version (3.8.1), a time (10:30), a phone number (010-1234). */
const BEFORE = String.raw`(?<![A-Za-z0-9.,:\-_/#@+])`;
/**
 * What may follow a Hangul unit: anything but Hangul, or a particle or suffix (5곳이, 3명의, 86주째, 5시께, 3개예요).
 * Any other syllable makes another word (명단, 시장, 개발, 분석, 일본), which is left alone.
 */
const AFTER_HANGUL = "이가을를은는의에께쯤씩도만과와로으부까째간나라당짜동안내뿐밖마보처입예여정반전후넘남상하요임인대";
const UNIT_END = `(?=$|[^가-힣A-Za-z0-9]|[${AFTER_HANGUL}])`;
const NUMBER = new RegExp(`${BEFORE}(?:(${AMOUNT})\\s*[~～\\u0000]\\s*)?(${AMOUNT})(여)?( ?)(${UNIT_PATTERN})${UNIT_END}`, "g");
/** 번 as a number, not a count (1번 출구, 3번 타자), and 대 as a rank (3대 은행, 5대 그룹), are read in 한자어. */
const NUMBERED_AFTER = /^ ?(?:출구|타자|타석|국도|게이트|버스|홀|트랙|채널|라인|레일|환자|확진자)/;
const RANK_AFTER = /^ [가-힣]/;

/** The value of 1,500, 4.2, 2만9000 or 1억2000만. */
function amountValue(raw: string): number {
  const plain = raw.replace(/,/g, "");
  if (/^\d+(?:\.\d+)?$/.test(plain)) return Number(plain);
  let total = 0;
  for (const [, digits = "", word = ""] of plain.matchAll(/(\d+(?:\.\d+)?)?([천만억조])?/g)) {
    if (digits || word) total += Number(digits || "1") * (BIG_WORDS[word] ?? 1);
  }
  return total;
}
/** 한자어 for an amount; decimals digit by digit after 점 (4.2 사 점 이; 1.5조 일 점 오조). */
function sinoAmount(raw: string): string {
  const decimal = /^(\d+)\.(\d+)([천만억조]?)$/.exec(raw.replace(/,/g, ""));
  if (!decimal) return sinoNumber(amountValue(raw));
  const [, whole = "", fraction = "", word = ""] = decimal;
  return `${sinoNumber(Number(whole))} 점 ${[...fraction].map(digit => at(DIGITS, Number(digit))).join("")}${word}`;
}
function readAmount(raw: string, reading: Reading, approximate: boolean): string {
  const value = amountValue(raw);
  if (!raw.includes(".") && !approximate) {
    if (reading === "month" && value >= 1 && value <= 12) return at(MONTHS, value);
    if (reading === "ordinal" && value === 1) return "첫";
    const native = nativeNumber(value);
    const counted = reading === "native" || reading === "ordinal" || (reading === "hour" && value <= 12) || (reading === "dae" && value % 10 !== 0);
    if (native && counted) return native;
  }
  return sinoAmount(raw);
}

/**
 * The text with each number before a known unit written as it is read: 5곳 다섯 곳, 3명 세 명, 12시 열두 시, 20살 스무 살,
 * 6월 유월, 10월 시월, 120명 백이십 명, 4.2% 사 점 이 퍼센트, 2026년 이천이십육 년, 60여 명 육십여 명, 3~5곳 세 곳에서
 * 다섯 곳. A range sign between numbers is read 에서. Deterministic, so a script always sounds the same.
 */
export function spokenNumbers(text: string): string {
  const marked = text.replace(/(?<=\d(?:[가-힣%A-Za-z]{1,4})?)\s*[~～]\s*(?=\d)/g, "\u0000");
  const spoken = marked.replace(NUMBER, (match: string, from: string | undefined, amount: string, approximate: string | undefined,
    _space: string, unit: string, offset: number, whole: string) => {
    const entry = UNITS.get(unit);
    if (!entry) return match;
    const next = whole.slice(offset + match.length);
    let reading = entry.reading;
    if (unit === "번" && NUMBERED_AFTER.test(next)) reading = "sino";
    if (unit === "대" && RANK_AFTER.test(next)) reading = "sino";
    const say = (raw: string, near: boolean) => {
      const read = readAmount(raw, reading, near);
      if (near) return `${read}여 ${entry.spoken}`;
      return reading === "month" && read.endsWith("월") ? read : `${read} ${entry.spoken}`;
    };
    const said = say(amount, approximate !== undefined);
    return from === undefined ? said : `${say(from, false)}에서 ${said}`;
  });
  return spoken.replace(/\s*\u0000\s*/g, "에서 ");
}

const FIGURE = new RegExp(`${BEFORE}(${AMOUNT})(?:여)?(?:( ?)(${UNIT_PATTERN})${UNIT_END})?(?![\\dA-Za-z])`, "g");
/**
 * The numbers a text states (5곳, 2만9000개, 9월 28일, 4.2%, 2026), each with the ways a script may write it, without spaces or
 * commas: with its unit as written and as read (5곳, 다섯곳), else the bare digits. A single digit without a unit (5분의 1) is
 * left out, as are numbers glued to Latin letters (G7, GPT-6).
 */
export function statedFigures(text: string): { raw: string; forms: string[] }[] {
  const figures: { raw: string; forms: string[] }[] = [];
  for (const match of text.matchAll(FIGURE)) {
    const [whole, amount = "", , unit] = match;
    if (!unit && /^\d$/.test(amount)) continue;
    const compact = (value: string) => value.replace(/[\s,]/g, "");
    figures.push({ raw: whole, forms: unit ? [compact(whole), compact(spokenNumbers(whole))] : [compact(amount)] });
  }
  return figures;
}
