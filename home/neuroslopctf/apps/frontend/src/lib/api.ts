import type { UserProfile } from './types';

type ErrorDetail =
  | string
  | Array<{
      loc?: Array<string | number>;
      msg?: string;
      type?: string;
      ctx?: Record<string, unknown>;
    }>;

export class ApiError extends Error {
  status: number;
  detail: ErrorDetail | undefined;
  code = '';
  retryAfter = 0;

  constructor(status: number, message: string, detail?: ErrorDetail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export function detailToMessage(detail: ErrorDetail | undefined): string | null {
  if (typeof detail === 'string') return detail;
  if (!Array.isArray(detail)) return null;

  const messages = detail
    .map((item) => {
      if (!item?.msg) return null;
      const labels: Record<string, string> = {
        username: 'Имя пользователя', password: 'Пароль', title: 'Название',
        description: 'Условие', difficulty: 'Сложность', answer_flag: 'Флаг',
        reward_token: 'Токен', expires_in_minutes: 'Срок в минутах', q: 'Поиск',
      };
      const field = String(item.loc?.at(-1) ?? '');
      Object.assign(labels, {visibility:'Видимость',join_policy:'Вступление',starts_at:'Начало',freeze_at:'Заморозка',ends_at:'Окончание',team_mode:'Командный режим',team_size_max:'Размер команды',scoring:'Подсчёт очков',category:'Категория',base_points:'Очки',release_at:'Публикация',max_solves:'Лимит решений',body:'Текст',cost:'Стоимость',order:'Порядок',role:'Роль',status:'Статус',name:'Название',scopes:'Области доступа',competition_id:'Соревнование',expires_in_days:'Срок',max_uses:'Лимит использований',expires_in_hours:'Срок приглашения',subject:'Тема',audience:'Аудитория',team_id:'Команда',flag:'Флаг',invite_code:'Код приглашения',join_code:'Код команды',permission:'Право',confirm_slug:'Подтверждение',user_id:'Участник',captain_id:'Капитан',filename:'Имя файла',file:'Файл',pinned:'Закрепление',message:'Сообщение',comment:'Комментарий',task_slug:'Задание',internal:'Внутренняя заметка'});
      const context = item.ctx ?? {};
      const errors: Record<string, string> = {
        string_too_short: 'Минимум символов: ' + context.min_length,
        string_too_long: 'Максимум символов: ' + context.max_length,
        greater_than_equal: 'Минимальное значение: ' + context.ge,
        less_than_equal: 'Максимальное значение: ' + context.le,
        int_parsing: 'Введите целое число', int_from_float: 'Введите целое число',
        missing: 'Заполните обязательное поле', literal_error: 'Выберите значение из списка',
        value_error: item.msg,
      };
      const message = errors[item.type ?? ''] ?? 'Проверьте введённое значение';
      return (labels[field] ?? 'Параметр') + ': ' + message;
    })
    .filter((item): item is string => Boolean(item));

  return messages.length ? messages.join('. ') : null;
}

export async function apiRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Сервис не ответил. Проверьте соединение и повторите попытку.');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');

  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'detail' in payload
      ? (payload.detail as ErrorDetail)
      : undefined;
    const message = detailToMessage(detail) ?? `Запрос завершился с ошибкой ${response.status}`;
    const error = new ApiError(response.status, message, detail);
    error.code = payload?.code ?? '';
    error.retryAfter = Math.max(0, Number(response.headers.get('Retry-After')) || 0);
    throw error;
  }

  return payload as T;
}

export async function getCurrentUser(): Promise<UserProfile | null> {
  try {
    return await apiRequest<UserProfile>('/api/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function requireCurrentUser(returnTo = window.location.pathname + window.location.search): Promise<UserProfile | null> {
  const user = await getCurrentUser();
  if (user) return user;

  const next = encodeURIComponent(returnTo);
  window.location.replace(`/login?next=${next}`);
  return null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Не удалось выполнить действие. Повторите попытку.';
}

export function safeNextPath(fallback = '/competitions'): string {
  const value = new URLSearchParams(window.location.search).get('next');
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;

  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

export {formatDate, formatRemaining} from './format';

export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch {  }
  }

  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Не удалось скопировать текст');
}
