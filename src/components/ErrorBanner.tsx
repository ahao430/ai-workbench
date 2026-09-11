import { Alert, Button } from 'antd'

interface Props {
  error: string
  onRelogin?: () => void
}

/** 统一错误横幅；提供「重新接入」入口（清配置回到引导页） */
export default function ErrorBanner({ error, onRelogin }: Props) {
  return (
    <Alert
      type="error"
      showIcon
      message={error}
      className="mb-4"
      action={
        onRelogin ? (
          <Button size="small" danger onClick={onRelogin}>
            重新接入
          </Button>
        ) : undefined
      }
    />
  )
}
