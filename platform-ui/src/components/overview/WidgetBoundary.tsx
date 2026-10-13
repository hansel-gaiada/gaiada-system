"use client";
import { Component, type ReactNode } from "react";

// DW-3b: one block's error boundary. A widget whose read throws renders its title and "Unavailable" in its
// own place and nothing else on the page is touched. Never 0 and never an empty list: a failed read must
// not read as "nothing to do" (plan §3.3, §13 trap 4).
//
// The server component inside is a child, so a throw while it streams in reaches this boundary on the
// client. In production React hides the message behind a digest; the block says only "Unavailable".
export class WidgetBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="ov-block ov-block--unavailable" aria-label={this.props.title}>
        <h3 className="ov-block__title">{this.props.title}</h3>
        <p className="ov-block__note">Unavailable</p>
      </section>
    );
  }
}
