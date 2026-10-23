import { memo } from 'react'
import { useNavigate } from 'react-router'
import type { GameOverReason, UserId } from '../api/types'
import Button from '../ui/Button'
import { IconBack } from '../ui/icons'

interface Props {
  winner: UserId | null
  reason: GameOverReason | null
  me: UserId

  them: string
  isBot: boolean
}

function explain(won: boolean, reason: GameOverReason | null, them: string, isBot: boolean): string {
  switch (reason) {
    case 'victory':
      if (isBot) return won ? 'Весь флот бота на дне.' : 'Бот потопил ваш флот.'
      return won ? `Весь флот игрока ${them} на дне.` : `Ваш флот потоплен. Победа за ${them}.`
    case 'timeout':
      return won ? `Игрок ${them} не успел сделать ход — техническая победа.` : 'Время на ход вышло — техническое поражение.'
    case 'disconnected':
      return won ? `Игрок ${them} не вернулся в игру — победа засчитана вам.` : 'Вы слишком долго были не в сети.'
    default:
      return 'Партия окончена.'
  }
}

function GameOverCard({ winner, reason, me, them, isBot }: Props) {
  const navigate = useNavigate()
  const won = winner === me
  return (
    <section className={`card sketch over ${won ? 'over-win' : 'over-loss'}`} role="status">
      <div>
        <h2>{won ? 'Победа!' : 'Поражение'}</h2>
        <p>{explain(won, reason, them, isBot)}</p>
      </div>
      <Button variant="primary" icon={<IconBack />} onClick={() => navigate('/lobby')}>
        В лобби
      </Button>
    </section>
  )
}

export default memo(GameOverCard)
