import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import sadShip from '../assets/ships/doodle/ship4-hurt.svg'
import { useAuth } from '../auth/AuthContext'
import Button from '../ui/Button'
import { IconAnchor, IconKey } from '../ui/icons'

export default function Home() {
  const { status, check } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (status === 'idle') check()
  }, [status, check])

  return (
    <main className="page home">
      <div className="home-logo">
        <h1 className="underline">
          <IconAnchor size={56} /> Морской бой
        </h1>
        <img className="home-ship" src={sadShip} alt="Грустный линкор с обвисшими стволами" width={400} height={100} />
        <p className="home-note">
          <span>Капитан, корабли тебя уже заждались, а все их стволы обвисли((</span>
          <span>Надо это исправить: своди их в бой — и они сразу обрадуются!</span>
          <span>И это… больше не забывай про них, работа подождёт)</span>
        </p>
        <div className="home-actions" aria-busy={status !== 'authed' && status !== 'anon'}>
          {status === 'authed' && (
            <Button variant="primary" onClick={() => navigate('/lobby')}>
              Играть
            </Button>
          )}
          {status === 'anon' && (
            <>
              <Button variant="primary" icon={<IconKey />} onClick={() => navigate('/login')}>
                Вход
              </Button>
              <Button onClick={() => navigate('/login', { state: { mode: 'register' } })}>Регистрация</Button>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
