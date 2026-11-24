// Registers the Rust backend before anything makes a store. Imported first by App.tsx.
import * as native from "nsh-o11y/native";
import { setNativeBackend, type NativeBackend } from "nsh-o11y";

setNativeBackend(native as unknown as NativeBackend);
