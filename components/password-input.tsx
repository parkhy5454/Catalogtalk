'use client'
import { useState, type InputHTMLAttributes } from 'react'

// Password field with a 보기/숨김 toggle on the right. Hidden by default.
export default function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <input
        {...props}
        type={shown ? 'text' : 'password'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        style={{ paddingRight: 64, ...props.style }}
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? '비밀번호 숨기기' : '비밀번호 보기'}
        aria-pressed={shown}
        style={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          minWidth: 48,
          minHeight: 40,
          border: 0,
          background: 'transparent',
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--muted)',
          cursor: 'pointer',
        }}
      >
        {shown ? '숨김' : '보기'}
      </button>
    </div>
  )
}
