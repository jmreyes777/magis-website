//magis-project/admin-frontend/src/components/ErrorBoundary-Component.js

import React, { Component } from 'react';
import reportClientError from '../utils/errorReporter';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Error caught by ErrorBoundary:", error, errorInfo);
    // OBS1: surface staff-dashboard crashes on the Observability page.
    reportClientError("boundary", error, errorInfo && errorInfo.componentStack);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      const { error, errorInfo } = this.state;
      return (
        <div style={{ textAlign: 'center', marginTop: '50px', padding: '0 16px' }}>
          <h1>Something went wrong.</h1>
          <p>Try refreshing the page or contact support if the issue persists.</p>
          {/* Internal tool: surface the crash detail so a screenshot is enough
              to diagnose — no need to reproduce with DevTools open. */}
          {error && (
            <details
              style={{
                margin: '24px auto',
                maxWidth: 720,
                textAlign: 'left',
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 8,
                padding: '12px 16px',
              }}
            >
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#991b1b' }}>
                Technical details (share this with support)
              </summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  color: '#7f1d1d',
                }}
              >
                {String(error?.stack || error?.message || error)}
                {errorInfo?.componentStack
                  ? `\n\nComponent stack:${errorInfo.componentStack}`
                  : ''}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;