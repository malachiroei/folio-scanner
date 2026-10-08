import { Component, type ReactNode } from 'react'
import { CameraCapture } from './components/CameraCapture'
import { CornerEditor } from './components/CornerEditor'
import { DocumentViewer } from './components/DocumentViewer'
import { HomeScreen } from './components/HomeScreen'
import { PreviewScreen } from './components/PreviewScreen'
import { ProcessingScreen } from './components/ProcessingScreen'
import { Toast } from './components/Toast'
import { useScan } from './state/scan-context'
import { ScanProvider } from './state/ScanProvider'

function AppFrame() {
  const { screen, busy, toast, dismissToast } = useScan()

  return (
    <>
      {screen === 'home' && <HomeScreen />}
      {screen === 'camera' && <CameraCapture />}
      {screen === 'prepare' && <ProcessingScreen label={busy ?? 'מכין את התמונה…'} />}
      {screen === 'corners' && <CornerEditor />}
      {screen === 'preview' && <PreviewScreen />}
      {screen === 'pages' && <DocumentViewer />}
      {toast && <Toast message={toast} onDismiss={dismissToast} />}
    </>
  )
}

type BoundaryState = { message: string | null }

class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { message: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    console.error(error)
    return { message: error instanceof Error ? error.message : 'משהו השתבש.' }
  }

  componentDidCatch(error: unknown) {
    console.error(error)
  }

  render() {
    if (this.state.message) {
      return (
        <div className="app-bg flex min-h-dvh items-center justify-center px-6 text-ink dark:text-paper">
          <div className="max-w-sm text-center">
            <h1 className="font-display text-3xl font-semibold">משהו השתבש</h1>
            <p className="mt-3 text-sm text-mist dark:text-paper/65">{this.state.message}</p>
            <button
              type="button"
              className="mt-6 rounded-2xl bg-moss px-5 py-3 font-semibold text-paper active:scale-[0.98]"
              onClick={() => window.location.reload()}
            >
              טען מחדש
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <ScanProvider>
        <AppFrame />
      </ScanProvider>
    </AppErrorBoundary>
  )
}
