#include "signaling_client.h"

#include <rtc/rtc.hpp>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <utility>

// Each WebSocket callback holds its own lifetime gate rather than capturing a
// raw SignalingClient*. Replacing a closed socket must not dispatch stale
// callbacks into an already-reconnected or destroyed Agent worker.
struct SignalingCallbackGate {
    std::mutex mutex;
    std::condition_variable drained;
    std::atomic<std::uint64_t> generation{0};
    std::size_t activeCallbacks = 0;
    bool shuttingDown = false;
};

namespace {
    template <typename Callback>
    void DispatchIfCurrent(
        const std::shared_ptr<SignalingCallbackGate>& gate,
        std::uint64_t generation,
        Callback&& callback) {
        {
            std::lock_guard<std::mutex> lock(gate->mutex);
            if (gate->shuttingDown || gate->generation.load() != generation) return;
            ++gate->activeCallbacks;
        }
        try {
            callback();
        } catch (...) {
            // Never let exceptions cross an asynchronous libdatachannel callback
            // boundary and terminate the entire Windows service.
        }
        {
            std::lock_guard<std::mutex> lock(gate->mutex);
            --gate->activeCallbacks;
            if (gate->activeCallbacks == 0) gate->drained.notify_all();
        }
    }
}

SignalingClient::SignalingClient(std::string url)
    : m_url(std::move(url)),
      m_callbackGate(std::make_shared<SignalingCallbackGate>()) {}

SignalingClient::~SignalingClient() {
    const auto gate = m_callbackGate;
    {
        std::lock_guard<std::mutex> lock(gate->mutex);
        gate->shuttingDown = true;
        gate->generation.fetch_add(1);
    }
    std::shared_ptr<rtc::WebSocket> old;
    {
        std::lock_guard<std::mutex> lock(m_sendMu);
        old = std::move(m_ws);
    }
    if (old) {
        try {
            old->onOpen(nullptr);
            old->onMessage(nullptr);
            old->onClosed(nullptr);
            old->close();
        } catch (...) {
            // Teardown must never throw from the Windows service destructor.
        }
    }
    {
        std::unique_lock<std::mutex> lock(gate->mutex);
        gate->drained.wait(lock, [&gate]() {
            return gate->activeCallbacks == 0;
        });
    }
}

void SignalingClient::connect() {
    const auto gate = m_callbackGate;
    const auto generation = gate->generation.fetch_add(1) + 1;
    auto fresh = std::make_shared<rtc::WebSocket>();
    auto onOpen = m_openHandler;
    auto onMessage = m_messageHandler;
    auto onClosed = m_closedHandler;

    fresh->onOpen([gate, generation, onOpen]() {
        if (onOpen) DispatchIfCurrent(gate, generation, [&onOpen]() { onOpen(); });
    });

    fresh->onMessage([gate, generation, onMessage](rtc::message_variant data) {
        if (const auto* message = std::get_if<std::string>(&data)) {
            if (onMessage) {
                DispatchIfCurrent(gate, generation, [&onMessage, message]() {
                    onMessage(*message);
                });
            }
        }
    });

    fresh->onClosed([gate, generation, onClosed]() {
        if (onClosed) DispatchIfCurrent(gate, generation, [&onClosed]() { onClosed(); });
    });

    std::shared_ptr<rtc::WebSocket> previous;
    {
        std::lock_guard<std::mutex> lock(m_sendMu);
        previous = std::move(m_ws);
        m_ws = fresh;
    }
    if (previous) {
        previous->onOpen(nullptr);
        previous->onMessage(nullptr);
        previous->onClosed(nullptr);
        previous->close();
    }
    fresh->open(m_url);
}

void SignalingClient::send(const std::string& text) {
    std::shared_ptr<rtc::WebSocket> current;
    {
        std::lock_guard<std::mutex> lock(m_sendMu);
        current = m_ws;
    }
    if (!current) return;
    try {
        current->send(text);
    } catch (...) {
        // A network interruption must not crash the Agent from an event handler.
        // The closed callback/retry watchdog restores the signaling channel.
    }
}

void SignalingClient::onOpen(OpenHandler cb) {
    m_openHandler = std::move(cb);
}

void SignalingClient::onMessage(MessageHandler cb) {
    m_messageHandler = std::move(cb);
}

void SignalingClient::onClosed(ClosedHandler cb) {
    m_closedHandler = std::move(cb);
}
