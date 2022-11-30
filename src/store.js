import applyMixin from './mixin'
// import devtoolPlugin from './plugins/devtool'
import ModuleCollection from './module/module-collection'
import { forEachValue, isObject, isPromise, assert, partial } from './util'

let Vue // bind on install

export class Store {
  constructor (options = {}) {
    // Auto install if it is not done yet and `window` has `Vue`.
    // To allow users to avoid auto-installation in some cases,
    // this code should be placed here. See #731
    // CDN 形式自动安装
    if (!Vue && typeof window !== 'undefined' && window.Vue) {
      install(window.Vue)
    }

    const {
      plugins = [],
      strict = false
    } = options

    // 内部私有状态
    // store internal state
    this._committing = false // 是否在进行提交状态标识
    this._actions = Object.create(null) // acitons操作对象
    this._actionSubscribers = [] // 用来存放 actions 订阅
    this._mutations = Object.create(null) // mutations操作对象
    this._wrappedGetters = Object.create(null) // 封装后的getters集合对象
    // 模块收集器，构造模块树形结构
    this._modules = new ModuleCollection(options)
    // 用于存储模块命名空间的关系
    this._modulesNamespaceMap = Object.create(null)
    this._subscribers = []
    // 用于使用 $watch 观测 getters
    this._watcherVM = new Vue()
    // 用来存放生成的本地 getters 的缓存
    this._makeLocalGettersCache = Object.create(null)

    // bind commit and dispatch to self
    const store = this
    const { dispatch, commit } = this
    this.dispatch = function boundDispatch (type, payload) {
      return dispatch.call(store, type, payload)
    }
    this.commit = function boundCommit (type, payload, options) {
      return commit.call(store, type, payload, options)
    }

    // strict mode
    this.strict = strict

    // 根模块的state
    const state = this._modules.root.state

    // 初始化 根模块。
    // 并且也递归的注册所有子模块。
    // 将根模块、子模块的所有 mutations 都收集到 store._mutations
    // 将根模块、子模块的所有 actions 都收集到 store._actions
    // 将根模块、子模块的所有 getters 都收集到 store._wrappedGetters
    // 补全 state 内容，也就是将子 module 中的 state 集合到 根 state 中
    // state: { cart: {}, product: {} }
    installModule(this, state, [], this._modules.root)

    // 初始化 store._vm = new Vue({ data: { $$state: state }, computed })
    // 将 state、computed 初始化为响应式数据
    // 并且注册 _wrappedGetters 作为 computed 的属性
    resetStoreVM(this, state)

    // 应用插件
    // apply plugins
    plugins.forEach(plugin => plugin(this))
  }

  // this.$store.state 就是来自这里
  // 实际指向 this._vm.data.$$state
  // this._vm 表示一个空 Vue 实例对象
  get state () {
    return this._vm._data.$$state
  }

  set state (v) {
    // 代理 state 的 setter
    // 确保是只读的
  }

  /**
   * 提交 mutation
   * @param {String|Object} _type mutationType
   * @param {*} _payload 参数
   * @param {*} _options 选项 { root: true }
   * @returns
   */
  commit (_type, _payload, _options) {
    // 标准化出 type、payload、options
    // eg: cart/setCheckoutStatus
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload, _options)

    const mutation = { type, payload }
    const entry = this._mutations[type] // 取得对应的 mutation

    this._withCommit(() => {
      // mutation 是数组，需要挨个执行
      entry.forEach(function commitIterator (handler) {
        handler(payload)
      })
    })

    // 订阅 mutation 执行
    this._subscribers
      .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
      .forEach(sub => sub(mutation, this.state))
  }

  /**
   * 分发 actions
   * @param {*} _type
   * @param {*} _payload
   * @returns
   */
  dispatch (_type, _payload) {
    // 标准化处理 _type
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload)

    const action = { type, payload }
    const entry = this._actions[type] // 获取 action

    try {
      this._actionSubscribers
        .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
        .filter(sub => sub.before)
        .forEach(sub => sub.before(action, this.state))
    } catch (e) {
      if (__DEV__) {
        console.warn(`[vuex] error in before action subscribers: `)
        console.error(e)
      }
    }

    // 同名 action 也可以存在多个
    const result = entry.length > 1
      ? Promise.all(entry.map(handler => handler(payload)))
      : entry[0](payload)

    // dispatch 本身返回 Promise
    return new Promise((resolve, reject) => {
      // 处理异步 action 的结果
      result.then(res => {
        try {
          this._actionSubscribers
            .filter(sub => sub.after)
            .forEach(sub => sub.after(action, this.state))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in after action subscribers: `)
            console.error(e)
          }
        }
        // 将处理后的结果返回
        resolve(res)
      }, error => {
        try {
          this._actionSubscribers
            .filter(sub => sub.error)
            .forEach(sub => sub.error(action, this.state, error))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in error action subscribers: `)
            console.error(e)
          }
        }
        reject(error)
      })
    })
  }

  subscribe (fn, options) {
    return genericSubscribe(fn, this._subscribers, options)
  }

  subscribeAction (fn, options) {
    const subs = typeof fn === 'function' ? { before: fn } : fn
    return genericSubscribe(subs, this._actionSubscribers, options)
  }

  watch (getter, cb, options) {
    if (__DEV__) {
      assert(typeof getter === 'function', `store.watch only accepts a function.`)
    }
    return this._watcherVM.$watch(() => getter(this.state, this.getters), cb, options)
  }

  replaceState (state) {
    this._withCommit(() => {
      this._vm._data.$$state = state
    })
  }

  registerModule (path, rawModule, options = {}) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
      assert(path.length > 0, 'cannot register the root module by using registerModule.')
    }

    this._modules.register(path, rawModule)
    installModule(this, this.state, path, this._modules.get(path), options.preserveState)
    // reset store to update getters...
    resetStoreVM(this, this.state)
  }

  unregisterModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    this._modules.unregister(path)
    this._withCommit(() => {
      const parentState = getNestedState(this.state, path.slice(0, -1))
      Vue.delete(parentState, path[path.length - 1])
    })
    resetStore(this)
  }

  hasModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    return this._modules.isRegistered(path)
  }

  hotUpdate (newOptions) {
    this._modules.update(newOptions)
    resetStore(this, true)
  }

  _withCommit (fn) {
    const committing = this._committing
    this._committing = true
    fn()
    this._committing = committing
  }
}

function genericSubscribe (fn, subs, options) {
  if (subs.indexOf(fn) < 0) {
    options && options.prepend
      ? subs.unshift(fn)
      : subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

/**
 * 重置 Store
 * @param {*} store
 * @param {*} hot
 */
function resetStore (store, hot) {
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
  const state = store.state
  // init all modules
  installModule(store, state, [], store._modules.root, true)
  // reset vm
  resetStoreVM(store, state, hot)
}

function resetStoreVM (store, state, hot) {
  const oldVm = store._vm

  store.getters = {}
  store._makeLocalGettersCache = Object.create(null)
  // 获取所有的 getters
  const wrappedGetters = store._wrappedGetters
  const computed = {}
  // 遍历
  forEachValue(wrappedGetters, (fn, key) => {
    // 设置与 computed 对象内
    computed[key] = partial(fn, store)
    // 代理 store.getters
    // store.getters[key] = store._vm[key]
    Object.defineProperty(store.getters, key, {
      get: () => store._vm[key],
      enumerable: true // for local getters
    })
  })

  // 声明变量 silent 存储用户设置的静默模式配置
  // silent 会阻止所有的日志和警告
  const silent = Vue.config.silent
  Vue.config.silent = true
  // FIXME: 关键
  // 使用一个 Vue 实例对象存储 state 树
  store._vm = new Vue({
    data: {
      // 全局 state
      $$state: state
    },
    // 所有的 getter 计算属性
    computed
  })
  // 恢复全局的配置
  Vue.config.silent = silent

  // enable strict mode for new vm
  // 开启严格模式
  // 用 $watch 观测 state，只能使用 mutation 修改 也就是 _withCommit 函数
  if (store.strict) {
    enableStrictMode(store)
  }

  // 如果有老的 _vm
  if (oldVm) {
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      store._withCommit(() => {
        oldVm._data.$$state = null
      })
    }
    // 销毁老的 _vm 实例
    Vue.nextTick(() => oldVm.$destroy())
  }
}

/**
 * 安装整个模块集
 * @param {*} store 整个 Store 实例
 * @param {*} rootState state 对象
 * @param {*} path
 * @param {*} module 模块（根模块或者某个子模块）
 * @param {*} hot
 */
function installModule (store, rootState, path, module, hot) {
  const isRoot = !path.length // 根
  // 命名空间 字符串
  // 根 为 ""
  // eg: "cart/" "product/"
  const namespace = store._modules.getNamespace(path)

  // register in namespace map
  if (module.namespaced) {
    // 命名冲突了
    if (store._modulesNamespaceMap[namespace] && __DEV__) {
      console.error(`[vuex] duplicate namespace ${namespace} for the namespaced module ${path.join('/')}`)
    }
    // { [namespace]: Module }
    store._modulesNamespaceMap[namespace] = module
  }

  // set state
  if (!isRoot && !hot) {
    const parentState = getNestedState(rootState, path.slice(0, -1))
    const moduleName = path[path.length - 1]
    store._withCommit(() => {
      // 更新到 全局 state 中
      Vue.set(parentState, moduleName, module.state)
    })
  }

  // module.context
  // 主要是给 helpers 中 mapState、mapGetters、mapMutations、mapActions四个辅助函数使用的。
  // 生成本地的 dispatch、commit、getters 和 state。
  const local = module.context = makeLocalContext(store, namespace, path)

  // 遍历 mutation
  // 也就是 this._rawModule.mutations 用户传入的 mutation 内容
  module.forEachMutation((mutation, key) => {
    // eg: "cart/pushProductToCart"
    const namespacedType = namespace + key
    registerMutation(store, namespacedType, mutation, local)
  })

  // 遍历 actions
  // 也就是 this._rawModule.actions 用户传入的 action 内容
  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  // 遍历 getters
  // 也就是 this._rawModule.getters 用户传入的 getter 内容
  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key
    registerGetter(store, namespacedType, getter, local)
  })

  // 递归处理子模块
  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 */
function makeLocalContext (store, namespace, path) {
  const noNamespace = namespace === ''

  const local = {
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }

      return store.dispatch(type, payload)
    },

    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      store.commit(type, payload, options)
    }
  }

  // getters and state object must be gotten lazily
  // because they will be changed by vm update
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  })

  return local
}

function makeLocalGetters (store, namespace) {
  if (!store._makeLocalGettersCache[namespace]) {
    const gettersProxy = {}
    const splitPos = namespace.length
    Object.keys(store.getters).forEach(type => {
      // skip if the target getter is not match this namespace
      if (type.slice(0, splitPos) !== namespace) return

      // extract local getter type
      const localType = type.slice(splitPos)

      // Add a port to the getters proxy.
      // Define as getter property because
      // we do not want to evaluate the getters in this time.
      Object.defineProperty(gettersProxy, localType, {
        get: () => store.getters[type],
        enumerable: true
      })
    })
    store._makeLocalGettersCache[namespace] = gettersProxy
  }

  return store._makeLocalGettersCache[namespace]
}

/**
 * 注册 mutation
 * store._mutations[type] = []
 * store._mutations[type].push(wrappedMutationHandler)
 * @param {*} store
 * @param {*} type
 * @param {*} handler
 * @param {*} local
 */
function registerMutation (store, type, handler, local) {
  const entry = store._mutations[type] || (store._mutations[type] = [])
  entry.push(function wrappedMutationHandler (payload) {
    // 这里调用用户写的 mutation handler
    // 传入 state、payload 两个参数
    handler.call(store, local.state, payload)
  })
}

/**
 * 注册 action
 * store._actions[type] = []
 * store._actions[type].push(wrappedActionHandler)
 * @param {*} store
 * @param {*} type
 * @param {*} handler
 * @param {*} local
 */
function registerAction (store, type, handler, local) {
  const entry = store._actions[type] || (store._actions[type] = [])
  entry.push(function wrappedActionHandler (payload) {
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      rootGetters: store.getters,
      rootState: store.state
    }, payload)
    // 非 Promise 也会转为 Promise
    if (!isPromise(res)) {
      res = Promise.resolve(res)
    }
    // 返回的是 Promise 对象
    return res
  })
}

/**
 * 注册 getter
 * store._wrappedGetters = {}
 * store._wrappedGetters[type] = wrappedGetter
 * @param {*} store
 * @param {*} type
 * @param {*} rawGetter
 * @param {*} local
 * @returns
 */
function registerGetter (store, type, rawGetter, local) {
  if (store._wrappedGetters[type]) {
    if (__DEV__) {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }
  store._wrappedGetters[type] = function wrappedGetter (store) {
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

// 开启严格模式
function enableStrictMode (store) {
  // 深度 监听 this._data.$$state
  // 当发生变化的时候，如果 _committing 为 false，就给出警告提示
  store._vm.$watch(function () { return this._data.$$state }, () => {
    if (__DEV__) {
      assert(store._committing, `do not mutate vuex store state outside mutation handlers.`)
    }
  }, { deep: true, sync: true })
}

// 获取前套的 state
function getNestedState (state, path) {
  return path.reduce((state, key) => state[key], state)
}

/**
 * mutation 第一个参数可以是对象，也可以是 string
 * @param {*} type
 * @param {*} payload
 * @param {*} options
 * @returns
 */
function unifyObjectStyle (type, payload, options) {
  // 对象形式，进行解构
  // https://v3.vuex.vuejs.org/zh/guide/mutations.html#%E5%AF%B9%E8%B1%A1%E9%A3%8E%E6%A0%BC%E7%9A%84%E6%8F%90%E4%BA%A4%E6%96%B9%E5%BC%8F
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  return { type, payload, options }
}

/**
 * 插件安装函数
 * @param {*} _Vue
 * @returns
 */
export function install (_Vue) {
  if (Vue && _Vue === Vue) {
    // 已经安装过了
    return
  }

  Vue = _Vue
  // 应用 Mixin 完成混入
  applyMixin(Vue)
}
