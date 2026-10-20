import XCTest
@testable import PabootProtocol

final class ReconnectPolicyTests: XCTestCase {
    // MARK: - Backoff

    func testBackoffStartsAtOneSecondAndDoubles() {
        // jitter = 0.5 → multiplier 1.0, so the table value is used verbatim.
        XCTAssertEqual(ReconnectPolicy.backoffMs(attempt: 0, jitter: 0.5), 1_000)
        XCTAssertEqual(ReconnectPolicy.backoffMs(attempt: 1, jitter: 0.5), 2_000)
        XCTAssertEqual(ReconnectPolicy.backoffMs(attempt: 2, jitter: 0.5), 4_000)
        XCTAssertEqual(ReconnectPolicy.backoffMs(attempt: 3, jitter: 0.5), 8_000)
        XCTAssertEqual(ReconnectPolicy.backoffMs(attempt: 4, jitter: 0.5), 15_000)
    }

    func testBackoffCapsAtThirtySeconds() {
        XCTAssertEqual(ReconnectPolicy.backoffMs(attempt: 5, jitter: 0.5), 30_000)
        XCTAssertEqual(ReconnectPolicy.backoffMs(attempt: 50, jitter: 0.5), 30_000)
    }

    func testBackoffJitterRangesFromHalfToFifteenTimes() {
        XCTAssertEqual(ReconnectPolicy.backoffMs(attempt: 5, jitter: 0.0), 15_000)
        XCTAssertEqual(ReconnectPolicy.backoffMs(attempt: 5, jitter: 1.0), 45_000)
    }

    // MARK: - Retryability

    func testRequestAndAuthErrorsAreNotRetryable() {
        for code in [400, 401, 403, 404] {
            XCTAssertTrue(ReconnectPolicy.isNonRetryable(httpCode: code), "HTTP \(code)")
        }
    }

    func testServerAndConnectionErrorsAreRetryable() {
        for code in [408, 500, 502, 503, nil] as [Int?] {
            XCTAssertFalse(ReconnectPolicy.isNonRetryable(httpCode: code), "HTTP \(String(describing: code))")
        }
    }

    // MARK: - Decisions

    func testTerminalEventFinishesRegardlessOfOtherInputs() {
        let decision = ReconnectPolicy.decide(
            terminal: true,
            httpCode: 401,
            runActive: nil,
            unreachableMs: Int64.max,
            attempt: 9,
            jitter: 0.5
        )
        XCTAssertEqual(decision, .finished)
    }

    func testNonRetryableStatusGivesUp() {
        let decision = ReconnectPolicy.decide(
            terminal: false,
            httpCode: 404,
            runActive: true,
            unreachableMs: 0,
            attempt: 0,
            jitter: 0.5
        )
        XCTAssertEqual(decision, .giveUp)
    }

    func testRunGoneFromDaemonSettles() {
        let decision = ReconnectPolicy.decide(
            terminal: false,
            httpCode: nil,
            runActive: false,
            unreachableMs: 0,
            attempt: 0,
            jitter: 0.5
        )
        XCTAssertEqual(decision, .settled)
    }

    func testActiveRunRetriesWithBackoff() {
        let decision = ReconnectPolicy.decide(
            terminal: false,
            httpCode: nil,
            runActive: true,
            unreachableMs: 0,
            attempt: 1,
            jitter: 0.5
        )
        XCTAssertEqual(decision, .retry(delayMs: 2_000))
    }

    func testUnreachableDaemonRetriesFirst() {
        let decision = ReconnectPolicy.decide(
            terminal: false,
            httpCode: nil,
            runActive: nil,
            unreachableMs: 0,
            attempt: 0,
            jitter: 0.5
        )
        guard case .retry = decision else {
            return XCTFail("expected retry, got \(decision)")
        }
    }

    func testUnreachableDaemonGivesUpAfterBudget() {
        let decision = ReconnectPolicy.decide(
            terminal: false,
            httpCode: nil,
            runActive: nil,
            unreachableMs: ReconnectPolicy.unreachableBudgetMs,
            attempt: 3,
            jitter: 0.5
        )
        XCTAssertEqual(decision, .giveUp)
    }

    func testActiveRunIgnoresUnreachableBudget() {
        let decision = ReconnectPolicy.decide(
            terminal: false,
            httpCode: nil,
            runActive: true,
            unreachableMs: ReconnectPolicy.unreachableBudgetMs * 10,
            attempt: 9,
            jitter: 0.5
        )
        guard case .retry = decision else {
            return XCTFail("expected retry, got \(decision)")
        }
    }
}
