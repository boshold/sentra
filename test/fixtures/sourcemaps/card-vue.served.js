import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/components/Card.vue");import { defineComponent as _defineComponent } from "/node_modules/.vite/deps/vue.js?v=e5cddbeb";
import { ref } from "/node_modules/.vite/deps/vue.js?v=e5cddbeb";
const _sfc_main = /*@__PURE__*/ _defineComponent({
	__name: "Card",
	setup(__props, { expose: __expose }) {
		__expose();
		const count = ref(0);
		function explode(input) {
			const doubled = input * 2;
			throw new Error("boom " + doubled);
		}
		function onClick() {
			count.value = explode(count.value);
		}
		const __returned__ = {
			count,
			explode,
			onClick
		};
		Object.defineProperty(__returned__, "__isScriptSetup", {
			enumerable: false,
			value: true
		});
		return __returned__;
	}
});
import { toDisplayString as _toDisplayString, openBlock as _openBlock, createElementBlock as _createElementBlock } from "/node_modules/.vite/deps/vue.js?v=e5cddbeb";
function _sfc_render(_ctx, _cache, $props, $setup, $data, $options) {
	return _openBlock(), _createElementBlock(
		"button",
		{ onClick: $setup.onClick },
		"Count " + _toDisplayString($setup.count),
		1
		/* TEXT */
	);
}
import "/src/components/Card.vue?vue&type=style&index=0&scoped=c6c3362a&lang.css";
_sfc_main.__hmrId = "c6c3362a";
typeof __VUE_HMR_RUNTIME__ !== "undefined" && __VUE_HMR_RUNTIME__.createRecord(_sfc_main.__hmrId, _sfc_main);
import.meta.hot.on("file-changed", ({ file }) => {
	__VUE_HMR_RUNTIME__.CHANGED_FILE = file;
});
import.meta.hot.accept((mod) => {
	if (!mod) return;
	const { default: updated, _rerender_only } = mod;
	if (_rerender_only) {
		__VUE_HMR_RUNTIME__.rerender(updated.__hmrId, updated.render);
	} else {
		__VUE_HMR_RUNTIME__.reload(updated.__hmrId, updated);
	}
});
import _export_sfc from "/@id/__x00__plugin-vue:export-helper";
export default /*#__PURE__*/ _export_sfc(_sfc_main, [
	["render", _sfc_render],
	["__scopeId", "data-v-c6c3362a"],
	["__file", "/app/src/components/Card.vue"]
]);

//# sourceMappingURL=data:application/json;base64,eyJtYXBwaW5ncyI6IjtBQUNBLFNBQVMsV0FBVzs7Ozs7RUFFcEIsTUFBTSxRQUFRLElBQUksQ0FBQztFQUVuQixTQUFTLFFBQVEsT0FBdUI7R0FDdEMsTUFBTSxVQUFVLFFBQVE7R0FDeEIsTUFBTSxJQUFJLE1BQU0sVUFBVSxPQUFPO0VBQ25DO0VBRUEsU0FBUyxVQUFVO0dBQ2pCLE1BQU0sUUFBUSxRQUFRLE1BQU0sS0FBSztFQUNuQzs7Ozs7Ozs7Ozs7Ozs7O0NBSUUsT0FBQSxXQUFBLEdBQUE7RUFBbUQ7RUFBQSxFQUExQyxTQUFPLE9BQUEsUUFBTztFQUFFLFdBQU0saUJBQUcsT0FBQSxLQUFLO0VBQUE7O0NBQUEiLCJuYW1lcyI6W10sInNvdXJjZXMiOlsiQ2FyZC52dWUiXSwidmVyc2lvbiI6Mywic291cmNlc0NvbnRlbnQiOlsiPHNjcmlwdCBzZXR1cCBsYW5nPVwidHNcIj5cbmltcG9ydCB7IHJlZiB9IGZyb20gJ3Z1ZSdcblxuY29uc3QgY291bnQgPSByZWYoMClcblxuZnVuY3Rpb24gZXhwbG9kZShpbnB1dDogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgZG91YmxlZCA9IGlucHV0ICogMlxuICB0aHJvdyBuZXcgRXJyb3IoJ2Jvb20gJyArIGRvdWJsZWQpXG59XG5cbmZ1bmN0aW9uIG9uQ2xpY2soKSB7XG4gIGNvdW50LnZhbHVlID0gZXhwbG9kZShjb3VudC52YWx1ZSlcbn1cbjwvc2NyaXB0PlxuXG48dGVtcGxhdGU+XG4gIDxidXR0b24gQGNsaWNrPVwib25DbGlja1wiPkNvdW50IHt7IGNvdW50IH19PC9idXR0b24+XG48L3RlbXBsYXRlPlxuXG48c3R5bGUgc2NvcGVkPlxuYnV0dG9uIHsgY29sb3I6IHJlZDsgfVxuPC9zdHlsZT5cbiJdfQ==