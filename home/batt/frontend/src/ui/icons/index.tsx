import type { ReactNode } from 'react'

interface IconProps {
  size?: number
  title?: string
  className?: string
}

function Icon({ size = 22, title, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {children}
    </svg>
  )
}

export const IconAnchor = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="4.6" r="1.9" />
    <path d="M12.1 6.6c-.1 4.9.1 10.1-.1 15" />
    <path d="M7.9 10.1c2.9-.2 5.6.1 8.3-.1" />
    <path d="M4.2 14.4c.5 4.2 4 6.9 7.8 6.9 4 .1 7.4-2.8 7.8-7" />
    <path d="M3 15.8l1.3-1.6 1.8 1.2M21.1 15.6l-1.4-1.6-1.8 1.4" />
  </Icon>
)

export const IconExit = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.8 4.1c-2.9-.1-5.8.1-8.6 0 .1 5.3-.1 10.6.1 15.9 2.8-.1 5.6.1 8.4 0" />
    <path d="M10.2 12.1c3.6.1 7.2-.1 10.6 0" />
    <path d="M17.6 8.6c1.2 1.2 2.2 2.3 3.3 3.5-1.1 1.2-2.2 2.3-3.4 3.4" />
  </Icon>
)

export const IconBack = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.6 12.3c-5.4-.2-10.9.1-16.3-.1" />
    <path d="M9.4 6.4c-1.8 1.9-3.4 3.9-5.2 5.8 1.8 1.9 3.5 3.8 5.4 5.6" />
  </Icon>
)

export const IconRotate = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19.4 12.7c-.4 4-3.7 7-7.6 6.9-4.2-.1-7.5-3.5-7.4-7.7.1-4.1 3.5-7.4 7.6-7.3 2.4.1 4.4 1.2 5.8 3" />
    <path d="M18.4 3.7c.1 1.6-.1 3.2.1 4.9-1.6.1-3.3-.1-4.9.1" />
  </Icon>
)

export const IconDice = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.3 4.6c5.1-.2 10.3.1 15.4-.1.1 5 .1 10-.1 15-5.1.1-10.2-.1-15.3.1-.1-5 .1-10-.1-15z" />
    <circle cx="8.4" cy="8.6" r=".9" fill="currentColor" />
    <circle cx="15.6" cy="8.4" r=".9" fill="currentColor" />
    <circle cx="12" cy="12.1" r=".9" fill="currentColor" />
    <circle cx="8.5" cy="15.7" r=".9" fill="currentColor" />
    <circle cx="15.5" cy="15.6" r=".9" fill="currentColor" />
  </Icon>
)

export const IconEraser = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.2 4.4c2 2 4.1 3.9 6 6-3.4 3.5-6.8 6.8-10.1 10.2-2-2-4-3.9-6-6 3.3-3.5 6.7-6.8 10.1-10.2z" />
    <path d="M9.1 9.4c2 2 4 3.9 6 6" />
    <path d="M10.4 20.5c3.4.1 6.8-.1 10.2 0" />
  </Icon>
)

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.2 12.8c1.8 1.7 3.5 3.5 5.3 5.4 3.4-4.3 6.9-8.5 10.6-12.6" />
  </Icon>
)

export const IconSend = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.4 11.2c5.9-2.4 11.7-4.9 17.5-7.2-2.1 5.8-4.4 11.6-6.6 17.4-1.1-2.8-2.3-5.5-3.4-8.3-2.5-.6-5-1.2-7.5-1.9z" />
    <path d="M10.9 13.1c3.3-3 6.6-6 10-9" />
  </Icon>
)

export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8.6 8.4c3.9-.1 7.8.1 11.7 0 .1 3.9-.1 7.8.1 11.7-3.9.1-7.8-.1-11.7.1-.1-3.9.1-7.9-.1-11.8z" />
    <path d="M15.6 4.3c-3.8-.1-7.6.1-11.4 0-.1 3.8.1 7.6 0 11.4" />
  </Icon>
)

export const IconBot = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.1 8.3c4.6-.1 9.2.1 13.8-.1.1 3.8-.1 7.7.1 11.5-4.6.1-9.2-.1-13.8.1-.1-3.8.1-7.7-.1-11.5z" />
    <path d="M12 8.2c.1-1.4-.1-2.7 0-4" />
    <circle cx="12" cy="3.4" r="1" />
    <circle cx="9.1" cy="12.6" r="1.1" />
    <circle cx="14.9" cy="12.5" r="1.1" />
    <path d="M9.1 16.4c1.9.2 3.9-.1 5.8.1M3 12.4c.1 1.3-.1 2.6 0 3.9M21.1 12.3c-.1 1.3.1 2.7 0 4" />
  </Icon>
)

export const IconFriends = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8.6" cy="8.2" r="3.1" />
    <path d="M2.8 19.6c.3-3.4 2.8-5.6 5.8-5.6 3.1.1 5.4 2.4 5.7 5.7" />
    <path d="M15.3 5.4c1.9-.4 3.8 1 3.9 3 .1 1.8-1.3 3.2-3 3.3" />
    <path d="M17.2 14.3c2.3.5 3.9 2.6 4.1 5.1" />
  </Icon>
)

export const IconKey = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7.6" cy="12.1" r="3.6" />
    <path d="M11.2 12.2c3.2-.1 6.4.1 9.6-.1M17.6 12.1c0 1.3.1 2.5 0 3.7M20.6 12.2c.1 1 0 2 .1 3" />
  </Icon>
)

export const IconChat = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.3 5.1c5.2-.2 10.4.1 15.6-.1.1 3.6-.1 7.2.1 10.8-3.3.1-6.6-.1-9.8.1-1.6 1.3-3.1 2.6-4.8 3.8.2-1.3.4-2.6.5-3.9-.6 0-1.1-.1-1.6 0-.1-3.6.1-7.1 0-10.7z" />
    <path d="M8.2 9.3c2.6.1 5.1-.1 7.7 0M8.3 12.1c1.7.1 3.3-.1 5 0" />
  </Icon>
)
