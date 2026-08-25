import { renderHook, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useTheme } from "../hooks/useTheme"

beforeEach(() => {
  localStorage.clear()
  document.documentElement.dataset.theme = ""
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useTheme", () => {
  it("starts with light theme when system prefers light", () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe("light")
  })

  it("starts with dark theme when system prefers dark", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe("dark")
  })

  it("uses stored theme from localStorage over system preference", () => {
    localStorage.setItem("comebackhere-theme", "dark")
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe("dark")
  })

  it("toggleTheme switches from light to dark", () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe("light")

    act(() => {
      result.current.toggleTheme()
    })

    expect(result.current.theme).toBe("dark")
  })

  it("toggleTheme switches from dark to light", () => {
    localStorage.setItem("comebackhere-theme", "dark")
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe("dark")

    act(() => {
      result.current.toggleTheme()
    })

    expect(result.current.theme).toBe("light")
  })

  it("toggleTheme persists to localStorage", () => {
    const { result } = renderHook(() => useTheme())

    act(() => {
      result.current.toggleTheme()
    })

    expect(localStorage.getItem("comebackhere-theme")).toBe("dark")
  })

  it("sets data-theme attribute on document.documentElement", () => {
    renderHook(() => useTheme())
    expect(document.documentElement.dataset.theme).toBe("light")
  })

  it("updates data-theme attribute after toggle", () => {
    const { result } = renderHook(() => useTheme())

    act(() => {
      result.current.toggleTheme()
    })

    expect(document.documentElement.dataset.theme).toBe("dark")
  })

  it("sets style.colorScheme on document.documentElement", () => {
    renderHook(() => useTheme())
    expect(document.documentElement.style.colorScheme).toBe("light")
  })

  it("updates style.colorScheme after toggle", () => {
    const { result } = renderHook(() => useTheme())

    act(() => {
      result.current.toggleTheme()
    })

    expect(document.documentElement.style.colorScheme).toBe("dark")
  })

  it("registers matchMedia change listener on mount", () => {
    const addEventListener = vi.fn()
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: "",
      onchange: null,
      addEventListener,
      removeEventListener: vi.fn(),
    })

    renderHook(() => useTheme())

    expect(addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    )
  })

  it("removes matchMedia listener on unmount", () => {
    const removeEventListener = vi.fn()
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener,
    })

    const { unmount } = renderHook(() => useTheme())
    unmount()

    expect(removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    )
  })
})
