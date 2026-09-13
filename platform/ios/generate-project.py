#!/usr/bin/env python3
"""Generate a minimal dependency-free Xcode app project; safe to regenerate."""
from pathlib import Path
root=Path(__file__).resolve().parent
project=root/'JobPilot.xcodeproj';project.mkdir(exist_ok=True)
(project/'project.pbxproj').write_text('''// !$*UTF8*$!
{
 archiveVersion = 1; classes = {}; objectVersion = 56;
 objects = {
 A00000000000000000000001 = {isa = PBXProject; buildConfigurationList = A00000000000000000000010; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en, Base); mainGroup = A00000000000000000000002; productRefGroup = A00000000000000000000003; projectDirPath = ""; projectRoot = ""; targets = (A00000000000000000000004); };
 A00000000000000000000002 = {isa = PBXGroup; children = (A00000000000000000000005,A00000000000000000000003); sourceTree = "<group>";};
 A00000000000000000000003 = {isa = PBXGroup; children = (A00000000000000000000006); name = Products; sourceTree = "<group>";};
 A00000000000000000000004 = {isa = PBXNativeTarget; buildConfigurationList = A00000000000000000000011; buildPhases = (A00000000000000000000007,A00000000000000000000008,A00000000000000000000009); buildRules = (); dependencies = (); name = JobPilot; productName = JobPilot; productReference = A00000000000000000000006; productType = "com.apple.product-type.application";};
 A00000000000000000000005 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = JobPilot/JobPilotApp.swift; sourceTree = "<group>";};
 A00000000000000000000006 = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = JobPilot.app; sourceTree = BUILT_PRODUCTS_DIR;};
 A00000000000000000000007 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A00000000000000000000012); runOnlyForDeploymentPostprocessing = 0;};
 A00000000000000000000008 = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;};
 A00000000000000000000009 = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;};
 A00000000000000000000010 = {isa = XCConfigurationList; buildConfigurations = (A00000000000000000000013,A00000000000000000000014); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;};
 A00000000000000000000011 = {isa = XCConfigurationList; buildConfigurations = (A00000000000000000000015,A00000000000000000000016); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;};
 A00000000000000000000012 = {isa = PBXBuildFile; fileRef = A00000000000000000000005;};
 A00000000000000000000013 = {isa = XCBuildConfiguration; buildSettings = {SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SWIFT_VERSION = 5.0;}; name = Debug;};
 A00000000000000000000014 = {isa = XCBuildConfiguration; buildSettings = {SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SWIFT_VERSION = 5.0;}; name = Release;};
 A00000000000000000000015 = {isa = XCBuildConfiguration; buildSettings = {PRODUCT_BUNDLE_IDENTIFIER = com.example.jobpilot; PRODUCT_NAME = "$(TARGET_NAME)"; INFOPLIST_FILE = JobPilot/Info.plist; TARGETED_DEVICE_FAMILY = "1,2"; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; CODE_SIGN_STYLE = Automatic;}; name = Debug;};
 A00000000000000000000016 = {isa = XCBuildConfiguration; buildSettings = {PRODUCT_BUNDLE_IDENTIFIER = com.example.jobpilot; PRODUCT_NAME = "$(TARGET_NAME)"; INFOPLIST_FILE = JobPilot/Info.plist; TARGETED_DEVICE_FAMILY = "1,2"; SWIFT_COMPILATION_MODE = wholemodule; CODE_SIGN_STYLE = Automatic;}; name = Release;};
 }; rootObject = A00000000000000000000001;
}
''')
print(project)
