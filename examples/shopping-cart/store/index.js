import Vue from 'vue'
import Vuex from '../../../dist/vuex.js'
import cart from './modules/cart'
import products from './modules/products'
import createLogger from '../../../src/plugins/logger'

Vue.use(Vuex)

const debug = process.env.NODE_ENV !== 'production'

export default new Vuex.Store({
  modules: {
    cart,
    products
  },
  state: {
    global: 'xx'
  },
  mutations: {
    setProducts (state, name) {
      state.global = name
    }
  },
  strict: debug,
  plugins: debug ? [createLogger()] : []
})
