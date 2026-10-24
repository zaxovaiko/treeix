import MeetingsHelper
import VoiceHelper

if CommandLine.arguments.dropFirst().first == "meetings" { runMeetings() } else { runVoice() }
