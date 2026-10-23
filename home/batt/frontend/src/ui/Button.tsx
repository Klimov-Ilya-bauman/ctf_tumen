import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost'
  icon?: ReactNode
}

export default function Button({ variant = 'default', icon, className, children, type = 'button', ...rest }: Props) {
  const cls = ['btn', 'sketch', variant !== 'default' && `btn-${variant}`, className].filter(Boolean).join(' ')
  return (
    <button type={type} className={cls} {...rest}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  )
}
