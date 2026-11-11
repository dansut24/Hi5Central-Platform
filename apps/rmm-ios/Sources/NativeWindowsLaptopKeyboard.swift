import SwiftUI
import UIKit

/// In-app keyboard for the authorised remote Windows session. Typed characters
/// are sent directly over WebRTC; the app never buffers or stores remote text.
struct NativeWindowsLaptopKeyboard: View {
    let onText: (String) -> Void
    let onKey: (String) -> Void
    let onChord: ([String]) -> Void
    let onUseSystemKeyboard: () -> Void
    let onHide: () -> Void

    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var shift = false
    @State private var capsLock = false
    @State private var fn = false
    @State private var numLock = true
    @State private var numPad = false
    @State private var modifiers = Set<String>()

    private var compact: Bool { verticalSizeClass == .compact }
    private var keyHeight: CGFloat { compact ? 26 : 35 }
    private var functionHeight: CGFloat { compact ? 22 : 27 }
    private let gap: CGFloat = 2

    private struct Key: Hashable {
        let label: String
        let shifted: String?
        let units: CGFloat
        let isBlank: Bool

        init(_ label: String, _ shifted: String? = nil, _ units: CGFloat = 1, blank: Bool = false) {
            self.label = label
            self.shifted = shifted
            self.units = units
            self.isBlank = blank
        }
    }

    private var shiftedLetters: Bool { shift != capsLock }

    var body: some View {
        GeometryReader { geometry in
            let width = max(0, geometry.size.width - 12)
            VStack(spacing: 5) {
                HStack(spacing: 6) {
                    Text("Hi5Central")
                        .font(.system(size: 12, weight: .semibold))
                    Spacer(minLength: 3)
                    headerButton("Laptop", selected: !numPad) { numPad = false }
                    headerButton("Num pad", selected: numPad) { numPad = true }
                    Button("iOS") { onUseSystemKeyboard() }
                        .accessibilityLabel("Switch to standard iPhone keyboard")
                    Button(action: onHide) {
                        Image(systemName: "keyboard.chevron.compact.down")
                            .font(.system(size: 15, weight: .medium))
                            .frame(width: 27, height: 28)
                    }
                    .accessibilityLabel("Hide remote keyboard")
                }
                .font(.system(size: 11))
                .buttonStyle(.plain)

                if numPad {
                    numberPadLayout(width: width)
                        .frame(maxHeight: .infinity, alignment: .top)
                } else {
                    laptopLayout(width: width)
                        .frame(maxHeight: .infinity, alignment: .top)
                }
            }
            .padding(.horizontal, 6)
            .padding(.top, 7)
            .padding(.bottom, 7)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Color(uiColor: .secondarySystemBackground))
        }
        .frame(height: compact ? 216 : 276)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Hi5Central Windows UK QWERTY keyboard")
    }

    private func headerButton(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 10, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? Color.accentColor : Color.primary)
                .padding(.horizontal, 6)
                .frame(height: 27)
                .background(selected ? Color.accentColor.opacity(0.14) : Color(uiColor: .tertiarySystemFill),
                            in: RoundedRectangle(cornerRadius: 7))
        }
    }

    private func laptopLayout(width: CGFloat) -> some View {
        VStack(spacing: gap) {
            keyRow(functionKeys(), width: width, height: functionHeight)
                .padding(.bottom, 3)
            keyRow([
                Key("\u{60}", "¬"), Key("1", "!"), Key("2", "\""), Key("3", "£"),
                Key("4", "$"), Key("5", "%"), Key("6", "^"), Key("7", "&"),
                Key("8", "*"), Key("9", "("), Key("0", ")"), Key("-", "_"),
                Key("=", "+"), Key("Backspace", nil, 2)
            ], width: width, height: keyHeight)

            // UK ISO laptop Enter physically spans both the Q and A rows.
            VStack(spacing: gap) {
                keyRow([
                    Key("Tab", nil, 1.5),
                    Key("q", "Q"), Key("w", "W"), Key("e", "E"), Key("r", "R"),
                    Key("t", "T"), Key("y", "Y"), Key("u", "U"), Key("i", "I"),
                    Key("o", "O"), Key("p", "P"), Key("[", "{"), Key("]", "}"),
                    Key("Enter", nil, 1.5, blank: true)
                ], width: width, height: keyHeight)
                keyRow([
                    Key("Caps", nil, 1.5),
                    Key("a", "A"), Key("s", "S"), Key("d", "D"), Key("f", "F"),
                    Key("g", "G"), Key("h", "H"), Key("j", "J"), Key("k", "K"),
                    Key("l", "L"), Key(";", ":"), Key("'", "@"), Key("#", "~"),
                    Key("Enter", nil, 1.5, blank: true)
                ], width: width, height: keyHeight)
            }
            .overlay(alignment: .topTrailing) {
                let enterWidth = (width - 13 * gap) * 1.5 / 15
                keyCap(Key("Enter"), width: enterWidth, height: keyHeight * 2 + gap)
                    .zIndex(50)
            }
            .zIndex(5)

            keyRow([
                Key("Shift", nil, 1.5), Key("\\", "|"),
                Key("z", "Z"), Key("x", "X"), Key("c", "C"), Key("v", "V"),
                Key("b", "B"), Key("n", "N"), Key("m", "M"),
                Key(",", "<"), Key(".", ">"), Key("/", "?"),
                Key("Shift", nil, 2), Key("↑", nil, 0.82)
            ], width: width, height: keyHeight)

            keyRow([
                Key("Ctrl", nil, 1.13), Key("Fn", nil, 0.76), Key("Win"),
                Key("Alt"), Key("Space", nil, 4.9), Key("AltGr", nil, 1.15),
                Key("Menu", nil, 0.93), Key("Ctrl", nil, 1.13),
                Key("←", nil, 0.85), Key("↓", nil, 0.85), Key("→", nil, 0.85)
            ], width: width, height: keyHeight)
        }
    }

    private func functionKeys() -> [Key] {
        let labels = fn
            ? ["Esc", "Home", "End", "PgUp", "PgDn", "Ins", "Del",
               "F7", "F8", "F9", "F10", "F11", "F12", "Del"]
            : ["Esc", "F1", "F2", "F3", "F4", "F5", "F6",
               "F7", "F8", "F9", "F10", "F11", "F12", "Del"]
        return labels.map { Key($0) }
    }

    private func keyRow(_ keys: [Key], width: CGFloat, height: CGFloat) -> some View {
        let usable = max(0, width - CGFloat(max(0, keys.count - 1)) * gap)
        let units = keys.reduce(CGFloat.zero) { $0 + $1.units }
        return HStack(spacing: gap) {
            ForEach(Array(keys.enumerated()), id: \.offset) { _, key in
                let keyWidth = units > 0 ? usable * key.units / units : 0
                if key.isBlank {
                    Color.clear.frame(width: keyWidth, height: height)
                } else {
                    keyCap(key, width: keyWidth, height: height)
                }
            }
        }
        .frame(width: width, height: height)
    }

    private func numberPadLayout(width: CGFloat) -> some View {
        let padGap: CGFloat = 5
        let col = max(0, (width - padGap * 3) / 4)
        let triple = col * 3 + padGap * 2
        let height: CGFloat = compact ? 30 : 44
        return VStack(spacing: padGap) {
            HStack(spacing: padGap) {
                padKey("Num Lock", width: col, height: height)
                padKey("/", width: col, height: height)
                padKey("*", width: col, height: height)
                padKey("-", width: col, height: height)
            }
            HStack(alignment: .top, spacing: padGap) {
                VStack(spacing: padGap) {
                    padRow(["7", "8", "9"], col: col, height: height, gap: padGap)
                    padRow(["4", "5", "6"], col: col, height: height, gap: padGap)
                }
                .frame(width: triple)
                padKey("+", width: col, height: height * 2 + padGap)
            }
            HStack(alignment: .top, spacing: padGap) {
                VStack(spacing: padGap) {
                    padRow(["1", "2", "3"], col: col, height: height, gap: padGap)
                    HStack(spacing: padGap) {
                        padKey("0", width: col * 2 + padGap, height: height)
                        padKey(".", width: col, height: height)
                    }
                }
                .frame(width: triple)
                padKey("Enter", width: col, height: height * 2 + padGap)
            }
        }
        .frame(width: width, alignment: .top)
    }

    private func padRow(_ values: [String], col: CGFloat, height: CGFloat,
                        gap: CGFloat) -> some View {
        HStack(spacing: gap) {
            ForEach(values, id: \.self) { padKey($0, width: col, height: height) }
        }
    }

    private func padKey(_ value: String, width: CGFloat, height: CGFloat) -> some View {
        keyCap(Key(value), width: width, height: height)
    }

    private func keyCap(_ key: Key, width: CGFloat, height: CGFloat) -> some View {
        let glyph = shownGlyph(for: key)
        let special = key.label.count > 1 || ["←", "→", "↑", "↓"].contains(key.label)
        let active = isLatched(key.label)
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            press(key)
        } label: {
            VStack(spacing: 0) {
                if let shifted = key.shifted, !shifted.isEmpty, !shift {
                    Text(shifted)
                        .font(.system(size: compact ? 7 : 8, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                } else if key.shifted != nil && shift {
                    Text(key.label)
                        .font(.system(size: compact ? 7 : 8))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(key.label == "Space" ? "" : glyph)
                    .font(.system(size: special ? (compact ? 8 : 9) : (compact ? 11 : 13),
                                  weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
            .frame(width: width, height: height)
            .contentShape(Rectangle())
        }
        .buttonStyle(WindowsPopupKeyStyle(glyph: key.label == "Space" ? "Space" : glyph,
                                          isLatched: active))
        .accessibilityLabel(key.label == "Space" ? "Space" : glyph)
        .accessibilityHint(key.shifted != nil ? "UK keyboard shifted option" : "")
    }

    private func shownGlyph(for key: Key) -> String {
        guard let shifted = key.shifted else { return key.label == "Win" ? "⊞" : key.label }
        if key.label.count == 1, key.label.first?.isLetter == true,
           key.label.utf8.count == 1 {
            return shiftedLetters ? shifted : key.label
        }
        return shift ? shifted : key.label
    }

    private func isLatched(_ label: String) -> Bool {
        switch label {
        case "Shift": return shift
        case "Caps": return capsLock
        case "Fn": return fn
        case "Num Lock": return numLock
        case "Ctrl": return modifiers.contains("ControlLeft")
        case "Win": return modifiers.contains("MetaLeft")
        case "Alt": return modifiers.contains("AltLeft")
        case "AltGr": return modifiers.contains("AltRight")
        default: return false
        }
    }

    private func press(_ key: Key) {
        switch key.label {
        case "Shift": shift.toggle(); return
        case "Caps": capsLock.toggle(); return
        case "Fn": fn.toggle(); return
        case "Num Lock": numLock.toggle(); return
        case "Ctrl": toggleModifier("ControlLeft"); return
        case "Alt": toggleModifier("AltLeft"); return
        case "AltGr": toggleModifier("AltRight"); return
        case "Win": toggleModifier("MetaLeft"); return
        default: break
        }

        if numPad && !numLock,
           let navigation = ["7": "Home", "8": "ArrowUp", "9": "PageUp",
                             "4": "ArrowLeft", "6": "ArrowRight",
                             "1": "End", "2": "ArrowDown", "3": "PageDown",
                             "0": "Insert", ".": "Delete"][key.label] {
            emitPhysical(navigation)
            resetOneShotModifiers()
            return
        }

        if let code = specialCode(for: key.label) {
            emitPhysical(code)
        } else if key.label == "Menu" {
            onChord(["ShiftLeft", "F10"])
        } else {
            let output = shownGlyph(for: key)
            if key.label == "Space" {
                emitPrintable(" ", physical: "Space")
            } else if key.label.count == 1 {
                emitPrintable(output, physical: physicalCode(for: key.label))
            }
        }
        resetOneShotModifiers()
    }

    private func toggleModifier(_ code: String) {
        if modifiers.contains(code) { modifiers.remove(code) }
        else { modifiers.insert(code) }
    }

    private func emitPrintable(_ text: String, physical: String?) {
        let chord = orderedModifiers()
        if chord.isEmpty {
            // Always use Unicode text_input for printable UK characters.
            onText(text)
        } else if let physical {
            var codes = chord
            if shift { codes.append("ShiftLeft") }
            codes.append(physical)
            onChord(codes)
        }
    }

    private func emitPhysical(_ code: String) {
        var codes = orderedModifiers()
        if shift { codes.append("ShiftLeft") }
        if codes.isEmpty { onKey(code) }
        else {
            codes.append(code)
            onChord(codes)
        }
    }

    private func orderedModifiers() -> [String] {
        ["ControlLeft", "AltLeft", "AltRight", "MetaLeft"]
            .filter { modifiers.contains($0) }
    }

    private func resetOneShotModifiers() {
        shift = false
        fn = false
        modifiers.removeAll()
    }

    private func physicalCode(for label: String) -> String? {
        if label.count == 1, let character = label.first {
            if label.utf8.count == 1 && character.isLetter {
                return "Key" + label.uppercased()
            }
            if character.isNumber { return "Digit" + label }
        }
        if label == "Space" { return "Space" }
        return nil
    }

    private func specialCode(for label: String) -> String? {
        switch label {
        case "Esc": return "Escape"
        case "Del", "Delete": return "Delete"
        case "Backspace", "⌫": return "Backspace"
        case "Tab": return "Tab"
        case "Enter": return "Enter"
        case "Ins": return "Insert"
        case "PgUp": return "PageUp"
        case "PgDn": return "PageDown"
        case "Home", "End": return label
        case "←": return "ArrowLeft"
        case "↑": return "ArrowUp"
        case "↓": return "ArrowDown"
        case "→": return "ArrowRight"
        default:
            return label.range(of: #"^F(?:[1-9]|1[0-2])$"#, options: .regularExpression) != nil
                ? label : nil
        }
    }
}

private struct WindowsPopupKeyStyle: ButtonStyle {
    let glyph: String
    let isLatched: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                (configuration.isPressed || isLatched)
                    ? Color.accentColor.opacity(0.22)
                    : Color(uiColor: .tertiarySystemBackground),
                in: RoundedRectangle(cornerRadius: 5)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(configuration.isPressed || isLatched
                            ? Color.accentColor : Color.primary.opacity(0.12),
                            lineWidth: 0.75)
            }
            .shadow(color: Color.black.opacity(configuration.isPressed ? 0 : 0.12),
                    radius: 0, y: configuration.isPressed ? 0 : 1.5)
            .overlay(alignment: .top) {
                if configuration.isPressed {
                    Text(glyph)
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .frame(minWidth: 48, minHeight: 48)
                        .background(Color(uiColor: .systemBackground),
                                    in: RoundedRectangle(cornerRadius: 11))
                        .overlay {
                            RoundedRectangle(cornerRadius: 11)
                                .stroke(Color.accentColor, lineWidth: 1.3)
                        }
                        .shadow(radius: 7, y: 3)
                        .offset(y: -52)
                        .allowsHitTesting(false)
                        .zIndex(90)
                }
            }
            .zIndex(configuration.isPressed ? 90 : 0)
    }
}
