import { ApiError } from './client'

const KNOWN: Record<string, string> = {
  network: 'Нет связи с сервером. Проверьте подключение.',
  unauthorized: 'Нужно войти заново.',
  forbidden: 'Нет доступа к этой партии.',
  'not found': 'Партия не найдена. Проверьте код комнаты.',
  'internal error': 'На сервере что-то сломалось. Попробуйте ещё раз.',
  'too many messages': 'Слишком часто. Подождите пару секунд.',
  'username already taken': 'Этот логин уже занят.',
  'username must be 3-32 chars: letters, digits, underscore': 'Логин: 3–32 символа, латиница, цифры и «_».',
  'password must be 8-128 chars': 'Пароль: от 8 до 128 символов.',
  'cannot join your own game': 'Это ваша собственная партия.',
  'game is not available for joining': 'В эту партию уже нельзя вступить.',
  'chat is available while the game is in progress': 'Чат доступен только во время партии.',
  'message is empty': 'Сообщение пустое.',
  'message is too long': 'Сообщение длиннее 500 символов.',
  'invalid message': 'Сервер не понял запрос.',
}

const WS_PATTERNS: [RegExp, string][] = [
  [/NotYourTurn/, 'Сейчас не ваш ход.'],
  [/AlreadyShot/, 'Сюда уже стреляли.'],
  [/AlreadyPlaced/, 'Корабли уже расставлены.'],
  [/BadFleet|WrongComposition|OutOfBounds|Touching/, 'Расстановка не подходит по правилам.'],
  [/WrongStatus/, 'Сейчас это действие недоступно.'],
  [/RateLimited/, 'Слишком часто. Подождите пару секунд.'],
  [/TooLong/, 'Сообщение длиннее 500 символов.'],
  [/Empty/, 'Сообщение пустое.'],
  [/NotParticipant/, 'Вы не участник этой партии.'],
]

export function describeError(e: unknown, fallback = 'Что-то пошло не так.'): string {
  if (e instanceof ApiError) {
    if (KNOWN[e.code]) return KNOWN[e.code]
    if (e.status === 401) return KNOWN.unauthorized
    if (e.status === 404) return KNOWN['not found']
    if (e.status >= 500) return KNOWN['internal error']
    return fallback
  }
  if (typeof e === 'string') return describeServerText(e) ?? fallback
  return fallback
}

export function describeServerText(text: string): string | null {
  if (KNOWN[text]) return KNOWN[text]
  for (const [re, msg] of WS_PATTERNS) if (re.test(text)) return msg
  return null
}
