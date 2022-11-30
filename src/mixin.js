export default function (Vue) {

  // 创建全局 Mixin
  // 为每个组件的 beforeCreate 钩子中添加初始化逻辑
  Vue.mixin({ beforeCreate: vuexInit })

  function vuexInit () {
    const options = this.$options
    // store injection
    // FIXME: 本质就是给每个组件都注入 this.$store 
    if (options.store) {
      // 根组件选项上才有 store
      // 根组件实例上挂载 $store 对象
      this.$store = typeof options.store === 'function'
        ? options.store()
        : options.store
    } else if (options.parent && options.parent.$store) {
      // 子组件的 $store 均指向父组件的
      this.$store = options.parent.$store
    }
  }
}
