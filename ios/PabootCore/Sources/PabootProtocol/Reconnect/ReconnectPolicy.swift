/// Decides what to do after one stream collect ends.
///
/// A run is decoupled from its connection: if the client drops, the daemon keeps running and
/// persists events by `(run_id, seq)`. "The stream ended" is therefore almost always retryable;
/// the only terminal cases are a terminal event, a non-retryable HTTP status, or a run that is
/// gone from the daemon.
public enum ReconnectPolicy {
    public enum Decision: Equatable, Sendable {
        /// Received a terminal event; the run finished normally.
        case finished

        /// The run is no longer on the daemon (finished / daemon restarted / cancelled).
        case settled

        /// Retrying cannot help (bad request, auth failure, missing run).
        case giveUp

        /// Reconnect after `delayMs`.
        case retry(delayMs: Int64)
    }

    /// Backoff table in milliseconds; the last entry is the cap.
    private static let backoffTable: [Int64] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

    /// A collect that lived this long (or received a frame) resets the backoff.
    public static let healthyAttemptMs: Int64 = 5_000

    /// How long we tolerate "daemon unreachable" before giving up. This bounds only the
    /// unreachable case; if the daemon is reachable and says the run is still active, retries
    /// continue without a budget.
    public static let unreachableBudgetMs: Int64 = 60_000

    /// These statuses mean the request itself is wrong, not the link.
    public static func isNonRetryable(httpCode: Int?) -> Bool {
        guard let httpCode else { return false }
        return [400, 401, 403, 404].contains(httpCode)
    }

    /// Delay after failure `attempt` (0-based), with jitter in `[0, 1)` scaling it to
    /// 0.5–1.5× so multiple clients do not reconnect in lockstep.
    public static func backoffMs(attempt: Int, jitter: Double) -> Int64 {
        let index = min(max(attempt, 0), backoffTable.count - 1)
        let base = Double(backoffTable[index])
        let clamped = min(max(jitter, 0.0), 1.0)
        return Int64(base * (0.5 + clamped))
    }

    /// - Parameters:
    ///   - terminal: whether this collect received a terminal event.
    ///   - httpCode: HTTP status from a failed collect; `nil` for connection-level failures.
    ///   - runActive: result of `GET /api/runs`; `nil` means the probe itself failed.
    ///   - unreachableMs: accumulated time the daemon has been unreachable.
    ///   - attempt: consecutive failed collects.
    ///   - jitter: `[0, 1)` random value.
    public static func decide(
        terminal: Bool,
        httpCode: Int?,
        runActive: Bool?,
        unreachableMs: Int64,
        attempt: Int,
        jitter: Double
    ) -> Decision {
        if terminal {
            return .finished
        }
        if isNonRetryable(httpCode: httpCode) {
            return .giveUp
        }
        if runActive == false {
            return .settled
        }
        if runActive == nil && unreachableMs >= unreachableBudgetMs {
            return .giveUp
        }
        return .retry(delayMs: backoffMs(attempt: attempt, jitter: jitter))
    }
}
