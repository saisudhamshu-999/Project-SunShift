import type { CropKey, FarmPlan } from '@/api/types'
import { fmt } from '@/lib/format'

export type Lang = 'en' | 'hi' | 'te'

export const LANGS: { id: Lang; label: string; native: string; speech: string }[] = [
  { id: 'te', label: 'Telugu', native: 'తెలుగు', speech: 'te-IN' },
  { id: 'hi', label: 'Hindi', native: 'हिन्दी', speech: 'hi-IN' },
  { id: 'en', label: 'English', native: 'English', speech: 'en-IN' },
]

const CROP: Record<Lang, Record<CropKey, string>> = {
  en: { cotton: 'Cotton', maize: 'Maize', groundnut: 'Groundnut', chilli: 'Chilli' },
  hi: { cotton: 'कपास', maize: 'मक्का', groundnut: 'मूंगफली', chilli: 'मिर्च' },
  te: { cotton: 'పత్తి', maize: 'మొక్కజొన్న', groundnut: 'వేరుశనగ', chilli: 'మిరప' },
}

const T = {
  en: {
    brand: 'SUNSHIFT',
    farm: 'Farm',
    today: 'Irrigate TODAY',
    water: 'm³ of water',
    why: 'Why',
    drying: 'soil is drying',
    needs: 'crop needs water',
    sun: 'strong sun',
    noRain: 'no rain expected',
    fairness: 'your turn after yesterday',
    reply: 'Reply',
    ok: 'OK',
    change: 'Change time',
    deferred: (mm: string) => `No irrigation today. Rain expected: ${mm} mm. Save water and power.`,
    notNeeded: 'No irrigation needed today. Your soil has enough water.',
    confirmed: (w: string) => `Confirmed. Pump window ${w}. We will call 10 minutes before.`,
    changeAsk: 'Reply with a time that suits you, e.g. 14:00. SunShift will re-plan the feeder and confirm.',
    call: (farm: string, a: string, b: string) => [
      'Namaskaram.',
      `This is SunShift for Farm ${farm}.`,
      `Your irrigation is scheduled today from ${a} to ${b}.`,
      'Press 1 to confirm.',
      'Press 2 to request another time.',
    ],
    callNone: (farm: string) => ['Namaskaram.', `This is SunShift for Farm ${farm}.`, 'No irrigation is needed today.', 'Press 1 to hear tomorrow’s plan.'],
    pressed1: 'Thank you. Your slot is confirmed.',
    pressed2: 'Noted. We will send you two other options by SMS.',
  },
  hi: {
    brand: 'सनशिफ्ट',
    farm: 'खेत',
    today: 'आज सिंचाई करें',
    water: 'घन मीटर पानी',
    why: 'कारण',
    drying: 'मिट्टी सूख रही है',
    needs: 'फसल को पानी चाहिए',
    sun: 'तेज़ धूप',
    noRain: 'बारिश की संभावना नहीं',
    fairness: 'कल के बाद आपकी बारी',
    reply: 'जवाब दें',
    ok: 'ठीक है',
    change: 'समय बदलें',
    deferred: (mm: string) => `आज सिंचाई न करें। बारिश की संभावना: ${mm} मिमी। पानी और बिजली बचाएं।`,
    notNeeded: 'आज सिंचाई की ज़रूरत नहीं। मिट्टी में पर्याप्त नमी है।',
    confirmed: (w: string) => `पुष्टि हो गई। पंप का समय ${w}। हम 10 मिनट पहले कॉल करेंगे।`,
    changeAsk: 'अपना सुविधाजनक समय भेजें, जैसे 14:00। सनशिफ्ट फीडर की योजना दोबारा बनाकर पुष्टि करेगा।',
    call: (farm: string, a: string, b: string) => [
      'नमस्ते।',
      `यह खेत ${farm} के लिए सनशिफ्ट है।`,
      `आज आपकी सिंचाई ${a} से ${b} तक तय है।`,
      'पुष्टि के लिए 1 दबाएं।',
      'दूसरा समय चाहिए तो 2 दबाएं।',
    ],
    callNone: (farm: string) => ['नमस्ते।', `यह खेत ${farm} के लिए सनशिफ्ट है।`, 'आज सिंचाई की ज़रूरत नहीं है।', 'कल की योजना सुनने के लिए 1 दबाएं।'],
    pressed1: 'धन्यवाद। आपका समय पक्का हो गया।',
    pressed2: 'ठीक है। हम SMS से दो और विकल्प भेजेंगे।',
  },
  te: {
    brand: 'సన్‌షిఫ్ట్',
    farm: 'పొలం',
    today: 'ఈ రోజు నీరు పెట్టండి',
    water: 'ఘన మీటర్ల నీరు',
    why: 'కారణం',
    drying: 'నేల ఎండిపోతోంది',
    needs: 'పంటకు నీరు కావాలి',
    sun: 'బలమైన ఎండ',
    noRain: 'వర్షం సూచన లేదు',
    fairness: 'నిన్నటి తర్వాత మీ వంతు',
    reply: 'జవాబు',
    ok: 'సరే',
    change: 'సమయం మార్చండి',
    deferred: (mm: string) => `ఈ రోజు నీరు పెట్టవద్దు. వర్షం సూచన: ${mm} మి.మీ. నీరు, విద్యుత్ ఆదా చేయండి.`,
    notNeeded: 'ఈ రోజు నీరు అవసరం లేదు. నేలలో తగినంత తేమ ఉంది.',
    confirmed: (w: string) => `నిర్ధారించబడింది. పంపు సమయం ${w}. 10 నిమిషాల ముందు కాల్ చేస్తాం.`,
    changeAsk: 'మీకు అనుకూలమైన సమయం పంపండి, ఉదా: 14:00. సన్‌షిఫ్ట్ ఫీడర్ ప్రణాళికను మళ్లీ రూపొందించి నిర్ధారిస్తుంది.',
    call: (farm: string, a: string, b: string) => [
      'నమస్కారం.',
      `ఇది పొలం ${farm} కోసం సన్‌షిఫ్ట్.`,
      `ఈ రోజు మీ నీటి సమయం ${a} నుండి ${b} వరకు.`,
      'నిర్ధారించడానికి 1 నొక్కండి.',
      'వేరే సమయం కావాలంటే 2 నొక్కండి.',
    ],
    callNone: (farm: string) => ['నమస్కారం.', `ఇది పొలం ${farm} కోసం సన్‌షిఫ్ట్.`, 'ఈ రోజు నీరు అవసరం లేదు.', 'రేపటి ప్రణాళిక వినడానికి 1 నొక్కండి.'],
    pressed1: 'ధన్యవాదాలు. మీ సమయం నిర్ధారించబడింది.',
    pressed2: 'సరే. మరో రెండు సమయాలను SMS ద్వారా పంపుతాము.',
  },
}

export function strings(lang: Lang) {
  return T[lang]
}

/** First scheduled block as start/end clock strings. */
export function firstWindow(farm: FarmPlan): [string, string] | null {
  const w = farm.schedule.window.split(',')[0]?.trim()
  if (!w) return null
  const [a, b] = w.split('–')
  return [a, b]
}

export function reasonsFor(farm: FarmPlan, lang: Lang): string[] {
  const t = T[lang]
  const level = (f: string) => farm.reasons.find((r) => r.factor === f)?.level
  const out: string[] = []
  out.push(['HIGH', 'SEVERE'].includes(level('Soil stress') ?? '') ? t.drying : t.needs)
  if (level('Solar availability') === 'HIGH') out.push(t.sun)
  if (level('Rain probability') === 'LOW') out.push(t.noRain)
  if (farm.servedYesterday < 0.98) out.push(t.fairness)
  return out
}

export interface Sms {
  lines: string[]
  actionable: boolean
}

export function smsFor(farm: FarmPlan, lang: Lang): Sms {
  const t = T[lang]
  const code = farm.code.slice(1)
  const head = `${t.brand} · ${t.farm} ${code}`
  if (farm.deferred) return { lines: [head, t.deferred(fmt(farm.rainExpectedMm))], actionable: false }
  const w = firstWindow(farm)
  if (!w) return { lines: [head, t.notNeeded], actionable: false }
  return {
    lines: [
      head,
      `${t.today} ${w[0]}–${w[1]}`,
      `${CROP[lang][farm.crop]} · ${fmt(farm.schedule.scheduledM3)} ${t.water}`,
      `${t.why}: ${reasonsFor(farm, lang).join(', ')}`,
      `${t.reply} 1 = ${t.ok}   2 = ${t.change}`,
    ],
    actionable: true,
  }
}

export function callScript(farm: FarmPlan, lang: Lang): string[] {
  const t = T[lang]
  const w = firstWindow(farm)
  return w ? t.call(farm.code.slice(1), w[0], w[1]) : t.callNone(farm.code.slice(1))
}
