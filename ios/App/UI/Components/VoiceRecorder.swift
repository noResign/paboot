import AVFoundation

enum VoiceRecorderError: LocalizedError {
    case cannotStart
}

/// Records 16 kHz mono 16-bit linear PCM into a temporary `.wav` for DeepSeek ASR.
/// Main-actor confined: the UI owns start/stop and the meter timer runs on the main run loop.
@MainActor
final class VoiceRecorder {
    static var permission: AVAudioApplication.RecordPermission {
        AVAudioApplication.shared.recordPermission
    }

    static func requestPermission() async -> Bool {
        if AVAudioApplication.shared.recordPermission == .granted { return true }
        return await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    var onLevel: ((Float) -> Void)?
    var onMaxDuration: (() -> Void)?

    private var recorder: AVAudioRecorder?
    private var url: URL?
    private var meterTimer: Timer?
    private var maxDurationTask: Task<Void, Never>?

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [])
        try session.setActive(true, options: [])

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("paboot-voice-\(UUID().uuidString).wav")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.isMeteringEnabled = true
        guard recorder.record() else {
            try? FileManager.default.removeItem(at: url)
            try? session.setActive(false, options: [.notifyOthersOnDeactivation])
            throw VoiceRecorderError.cannotStart
        }
        self.recorder = recorder
        self.url = url

        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self, let recorder = self.recorder else { return }
            recorder.updateMeters()
            let power = recorder.averagePower(forChannel: 0)
            let level = max(0, min(1, (power + 60) / 60))
            self.onLevel?(level)
        }
        maxDurationTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.onMaxDuration?() }
        }
    }

    /// Stops, deletes the temp file, and returns WAV bytes. Very short clips return nil.
    func stop() -> Data? {
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        recorder.stop()
        let url = self.url
        let data = url.flatMap { try? Data(contentsOf: $0) }
        cleanup()
        if let url { try? FileManager.default.removeItem(at: url) }
        guard duration >= 0.4, let data, data.count > 8_000 else { return nil }
        return data
    }

    func cancel() {
        recorder?.stop()
        let url = self.url
        cleanup()
        if let url { try? FileManager.default.removeItem(at: url) }
    }

    private func cleanup() {
        meterTimer?.invalidate()
        meterTimer = nil
        maxDurationTask?.cancel()
        maxDurationTask = nil
        recorder = nil
        url = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
