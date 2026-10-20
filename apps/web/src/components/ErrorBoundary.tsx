import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary для всего приложения.
 * Ловит runtime-ошибки рендеринга и показывает дружелюбный fallback
 * вместо белого экрана. Критично для Telegram WebApp, где пользователь
 * не может легко перезагрузить страницу через адресную строку.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // В продакшене здесь можно отправить ошибку в Sentry/LogRocket.
    // Пока логируем в консоль для отладки.
    console.error("[ErrorBoundary]", error, errorInfo.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "32px 24px",
            background: "#0a0a0a",
            color: "#fff",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 16 }}>😔</div>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 600,
              margin: "0 0 12px 0",
              lineHeight: 1.4,
            }}
          >
            Что-то пошло не так
          </h1>
          <p
            style={{
              fontSize: 15,
              color: "#999",
              margin: "0 0 32px 0",
              maxWidth: 360,
              lineHeight: 1.5,
            }}
          >
            Произошла ошибка при загрузке страницы.
            Попробуйте обновить — обычно это помогает.
          </p>
          <button
            onClick={this.handleReload}
            style={{
              background: "#c2410c",
              color: "#fff",
              border: "none",
              padding: "14px 40px",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
              transition: "background 0.2s",
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = "#ea580c")}
            onMouseOut={(e) => (e.currentTarget.style.background = "#c2410c")}
          >
            Обновить страницу
          </button>
          {this.state.error && (
            <details
              style={{
                marginTop: 32,
                maxWidth: 400,
                width: "100%",
                textAlign: "left",
              }}
            >
              <summary
                style={{
                  fontSize: 12,
                  color: "#666",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                Технические детали
              </summary>
              <pre
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: "#1a1a1a",
                  borderRadius: 8,
                  fontSize: 11,
                  color: "#f87171",
                  overflow: "auto",
                  maxHeight: 200,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {this.state.error.message}
                {"\n\n"}
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}