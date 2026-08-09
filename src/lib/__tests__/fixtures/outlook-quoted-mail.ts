export const OUTLOOK_QUOTED_MAIL = `
<style>
  .section { margin: 0 0 18px; padding: 8px; color: #203040; }
  .MsoNormal { margin: 0; font-family: Arial, sans-serif; font-size: 14px; line-height: 20px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px; vertical-align: top; }
  .unsafe { background-image: url(https://tracker.example/pixel); position: fixed; z-index: 9999; }
</style>
<div class="MsoNormal">---------- Forwarded message ----------</div>

<div class="section" id="greeting">
  <p>Dear project team,</p>
</div>

<table id="summary">
  <tbody>
    <tr>
      <td>
        <div class="section" id="overview">Long project description</div>
      </td>
    </tr>
  </tbody>
</table>

<div class="section" id="information">
  <p><strong>Project Information</strong></p>
  <table>
    <tr><td>Owner</td><td>MailMaestro</td></tr>
    <tr><td>Portal</td><td><a href="https://example.com/project">Open project</a></td></tr>
  </table>
</div>

<div class="section unsafe" id="signature" style="position:fixed;transform:scale(4);color:#334455">
  <p>Greetings,<br>Operations Team</p>
  <img src="cid:Company.Logo@Example" width="180" height="48" alt="Company logo">
</div>
`;
