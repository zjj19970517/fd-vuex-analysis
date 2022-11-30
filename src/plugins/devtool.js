const target = typeof window !== 'undefined'
  ? window
  : typeof global !== 'undefined'
    ? global
    : {}
const devtoolHook = target.__VUE_DEVTOOLS_GLOBAL_HOOK__

export default function devtoolPlugin (store) {
  if (!devtoolHook) return

  store._devtoolHook = devtoolHook

  devtoolHook.emit('vuex:init', store)

  // 时空穿梭的功能
  devtoolHook.on('vuex:travel-to-state', targetState => {
    // 直接替换成某个状态
    store.replaceState(targetState)
  })

  store.subscribe((mutation, state) => {
    // 订阅到的 mutation 的更新
    devtoolHook.emit('vuex:mutation', mutation, state)
  }, { prepend: true })

  store.subscribeAction((action, state) => {
    // 订阅到的 action 的更新
    devtoolHook.emit('vuex:action', action, state)
  }, { prepend: true })
}
